// Matching a list snapshot to the binding's links (D-010 §5.4, r3 R2-9).
//
// Markers (`lfcp://bridge/…`) are left out first, and so are the recurring
// copies a link ignores. Then:
//
// Pass 1, the links (linked, pending_*, out_of_filter, task_gone, unlinked,
// quarantine): candidates = by the link's TaskId in the URL ∪ by its
// externalId ∪ by its cached id.
//   0  → absent (conclusions only on a complete snapshot; §6.1, §6.3)
//   1  → matched. unlinked / task_gone / out_of_filter: a tombstone — the
//        reminder is taken and not synchronised. An empty URL with
//        url_state = ours → restore_url; a URL of the person's → user_replaced
//        (linked only)
//   >1 → a recurring copy (§6.4: with recurringCompletion = copy, the one
//        open reminder holds the link and the completed copies are ignored),
//        else quarantine(ambiguous_match)
//   one reminder claimed by two links → both quarantined (shared_item)
// Pass 2, the reminders left:
//   lfcp://task/<T> with our b, no link → link it if T is in the section and
//        the filter and it is T's only such reminder (or the open one of
//        recurring copies), else quarantine — several are never linked by order
//   lfcp://task/ with another b (or none) → hold foreign_bridge (§6.5)
//   a pending_lfcp_create whose keys found nothing → hold import_ambiguous:
//        no new reminder is imported
//   no lfcp URL, open → a new import (§6.2); a person's https URL is kept
//        (user_replaced)
//   no lfcp URL, completed → ignored
//
// Pure: it decides, the plan and the host act.

import type { CapabilityDeclaration } from "../capabilities.js";
import type { AppleItem } from "../transport.js";
import { isMarkerUrl } from "../values.js";
import { parseTaskLink } from "./link.js";

export type LinkState =
  | "pending_apple_create"
  | "pending_lfcp_create"
  | "linked"
  | "out_of_filter"
  | "task_gone"
  | "unlinked"
  | "quarantine";

/** A row of `links` (§3), as matching reads it. */
export interface LinkRow {
  readonly taskId: string;
  readonly state: LinkState;
  readonly origin: "lfcp" | "apple";
  readonly remUrl?: string;
  readonly remExternalId?: string;
  readonly remIdCache?: string;
  readonly urlState: "ours" | "missing" | "user_replaced";
  readonly statusLocked: boolean;
  readonly ignoredExternalIds: readonly string[];
}

export interface MatchContext {
  /** The binding's section, hex. */
  readonly section: string;
  /** This bridge's instance prefix (link `b`). */
  readonly bridge8: string;
  readonly recurringCompletion: CapabilityDeclaration["recurringCompletion"];
  /** Whether a Task is in the section (active) and in the binding's filter. */
  readonly task: (taskId: string) => { readonly inSection: boolean; readonly inFilter: boolean };
}

export type LinkMatch =
  | {
      readonly kind: "matched";
      readonly item: AppleItem;
      /** The URL is empty and ours to put back (§5.4; restore_url is PR 11's). */
      readonly restoreUrl: boolean;
      /** The person put a URL of their own there (linked only). */
      readonly userReplaced: boolean;
      /** Completed recurring copies to add to the link's ignored ids (§6.4). */
      readonly ignore: readonly string[];
    }
  | { readonly kind: "tombstone"; readonly item: AppleItem }
  | { readonly kind: "absent" }
  | {
      readonly kind: "ambiguous";
      readonly items: readonly AppleItem[];
      readonly reason: "ambiguous_match" | "shared_item";
    };

export type ItemOutcome =
  | {
      readonly kind: "orphan_link";
      readonly item: AppleItem;
      readonly taskId: string;
      /** Completed recurring copies of the same Task to ignore (§6.4). */
      readonly ignore: readonly string[];
    }
  | {
      readonly kind: "orphan_quarantine";
      readonly item: AppleItem;
      readonly taskId: string;
      readonly reason: "not_in_section" | "not_in_filter" | "other_section" | "ambiguous_orphans";
    }
  | { readonly kind: "foreign_bridge"; readonly item: AppleItem }
  | { readonly kind: "import"; readonly item: AppleItem; readonly userReplaced: boolean }
  | { readonly kind: "import_blocked"; readonly item: AppleItem }
  | {
      readonly kind: "ignore";
      readonly item: AppleItem;
      readonly reason: "completed" | "ignored_copy";
    };

export interface MatchResult {
  readonly links: ReadonlyMap<string, LinkMatch>;
  readonly items: readonly ItemOutcome[];
  readonly holds: readonly ("foreign_bridge" | "import_ambiguous")[];
}

const keyOf = (i: AppleItem) => i.ref.id;

function push<K, V>(m: Map<K, V[]>, k: K | undefined, v: V) {
  if (k === undefined) return;
  const a = m.get(k);
  if (a === undefined) m.set(k, [v]);
  else a.push(v);
}

const TOMBSTONES: ReadonlySet<LinkState> = new Set(["unlinked", "task_gone", "out_of_filter"]);

export function match(
  links: readonly LinkRow[],
  snapshot: readonly AppleItem[],
  ctx: MatchContext,
): MatchResult {
  const ignored = new Set(links.flatMap((l) => l.ignoredExternalIds));
  const items: ItemOutcome[] = [];
  const live: AppleItem[] = [];
  for (const i of snapshot) {
    if (isMarkerUrl(i.linkUrl)) continue;
    if (i.ref.externalId !== undefined && ignored.has(i.ref.externalId)) {
      items.push({ kind: "ignore", item: i, reason: "ignored_copy" });
      continue;
    }
    live.push(i);
  }
  const byTask = new Map<string, AppleItem[]>();
  const byExternal = new Map<string, AppleItem[]>();
  const byId = new Map<string, AppleItem[]>();
  for (const i of live) {
    const l = parseTaskLink(i.linkUrl);
    if (l !== undefined && (l.section === undefined || l.section === ctx.section))
      push(byTask, l.taskId, i);
    push(byExternal, i.ref.externalId, i);
    push(byId, i.ref.id, i);
  }

  // Pass 1.
  const out = new Map<string, LinkMatch>();
  const claims = new Map<string, string[]>();
  for (const link of links) {
    const found = new Map<string, AppleItem>();
    for (const i of [
      ...(byTask.get(link.taskId) ?? []),
      ...(link.remExternalId === undefined ? [] : (byExternal.get(link.remExternalId) ?? [])),
      ...(link.remIdCache === undefined ? [] : (byId.get(link.remIdCache) ?? [])),
    ])
      found.set(keyOf(i), i);
    const candidates = [...found.values()];
    let m: LinkMatch;
    if (candidates.length === 0) m = { kind: "absent" };
    else if (candidates.length === 1) {
      const item = candidates[0] as AppleItem;
      m = TOMBSTONES.has(link.state)
        ? { kind: "tombstone", item }
        : {
            kind: "matched",
            item,
            restoreUrl: item.linkUrl === undefined && link.urlState === "ours",
            userReplaced:
              link.state === "linked" &&
              item.linkUrl !== undefined &&
              parseTaskLink(item.linkUrl) === undefined,
            ignore: [],
          };
    } else {
      const open = candidates.filter((i) => !i.completed);
      const copies = candidates.filter((i) => i.completed);
      if (
        ctx.recurringCompletion === "copy" &&
        open.length === 1 &&
        copies.every((c) => c.ref.externalId !== undefined) &&
        !TOMBSTONES.has(link.state)
      ) {
        const item = open[0] as AppleItem;
        m = {
          kind: "matched",
          item,
          restoreUrl: false,
          userReplaced: false,
          ignore: copies.map((c) => c.ref.externalId as string),
        };
      } else m = { kind: "ambiguous", items: candidates, reason: "ambiguous_match" };
    }
    out.set(link.taskId, m);
    const claimed =
      m.kind === "matched" || m.kind === "tombstone"
        ? [m.item]
        : m.kind === "ambiguous"
          ? m.items
          : [];
    for (const i of claimed) push(claims, keyOf(i), link.taskId);
    if (m.kind === "matched")
      for (const c of found.values()) if (c !== m.item) push(claims, keyOf(c), link.taskId);
  }
  // One reminder, two links: both quarantined.
  for (const [key, taskIds] of claims) {
    const distinct = [...new Set(taskIds)];
    if (distinct.length < 2) continue;
    for (const t of distinct) {
      const prev = out.get(t);
      const its =
        prev?.kind === "ambiguous"
          ? prev.items
          : prev?.kind === "matched" || prev?.kind === "tombstone"
            ? [prev.item]
            : [];
      out.set(t, {
        kind: "ambiguous",
        items: its.length > 0 ? its : live.filter((i) => keyOf(i) === key),
        reason: "shared_item",
      });
    }
  }

  // Pass 2.
  const holds = new Set<"foreign_bridge" | "import_ambiguous">();
  const importAmbiguous = links.some(
    (l) => l.state === "pending_lfcp_create" && out.get(l.taskId)?.kind === "absent",
  );
  if (importAmbiguous) holds.add("import_ambiguous");
  // Orphans of ours, by Task, before any is linked (review PR 8 #9): one per Task, or
  // the recurring-copy rule; several otherwise → all quarantined, none linked.
  const orphans = new Map<string, AppleItem[]>();
  for (const i of live) {
    if (claims.has(keyOf(i))) continue;
    const l = parseTaskLink(i.linkUrl);
    if (l === undefined || l.bridge !== ctx.bridge8) continue;
    if (l.section !== undefined && l.section !== ctx.section) continue;
    push(orphans, l.taskId, i);
  }
  const orphan = (i: AppleItem, taskId: string): ItemOutcome => {
    const t = ctx.task(taskId);
    if (!t.inSection || !t.inFilter)
      return {
        kind: "orphan_quarantine",
        item: i,
        taskId,
        reason: t.inSection ? "not_in_filter" : "not_in_section",
      };
    const all = orphans.get(taskId) ?? [i];
    if (all.length === 1) return { kind: "orphan_link", item: i, taskId, ignore: [] };
    const open = all.filter((x) => !x.completed);
    const copies = all.filter((x) => x.completed);
    if (
      ctx.recurringCompletion === "copy" &&
      open.length === 1 &&
      copies.every((c) => c.ref.externalId !== undefined)
    )
      return open[0] === i
        ? {
            kind: "orphan_link",
            item: i,
            taskId,
            ignore: copies.map((c) => c.ref.externalId as string),
          }
        : { kind: "ignore", item: i, reason: "ignored_copy" };
    return { kind: "orphan_quarantine", item: i, taskId, reason: "ambiguous_orphans" };
  };
  for (const i of live) {
    if (claims.has(keyOf(i))) continue;
    const l = parseTaskLink(i.linkUrl);
    if (l !== undefined) {
      if (l.bridge !== ctx.bridge8) {
        holds.add("foreign_bridge");
        items.push({ kind: "foreign_bridge", item: i });
        continue;
      }
      if (l.section !== undefined && l.section !== ctx.section) {
        items.push({
          kind: "orphan_quarantine",
          item: i,
          taskId: l.taskId,
          reason: "other_section",
        });
        continue;
      }
      items.push(orphan(i, l.taskId));
      continue;
    }
    if (i.completed) items.push({ kind: "ignore", item: i, reason: "completed" });
    else if (importAmbiguous) items.push({ kind: "import_blocked", item: i });
    else items.push({ kind: "import", item: i, userReplaced: i.linkUrl !== undefined });
  }
  return { links: out, items, holds: [...holds] };
}
