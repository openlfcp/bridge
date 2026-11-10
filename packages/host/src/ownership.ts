// Ownership of "Apple account × ResourceId" (D-010 r4 §6.5, B16): one bridge per Apple ID is an
// operational limit, not a protocol guarantee. Each bound list carries this bridge's marker, a
// completed reminder with url lfcp://bridge/<bridgeInstanceId>?r=<ResourceId>. The marker only
// DETECTS another bridge; there is no lease and it is never renewed.
//
// Check (every full pass, and before effects resume after start or wake):
//   find(urlPrefix lfcp://bridge/, all lists)
//   incomplete        → not checked: effects to Apple wait
//   another instance  → hold foreign_bridge (lifted when that marker is gone)
//   own marker gone   → hold ownership_lost (never lifted automatically, never re-created: a person
//                       may have removed it on purpose during a takeover)
//   own, none foreign → checked

import { MARKER_PREFIX } from "@openlfcp/bridge-reminders";
import type { RemindersTransport } from "@openlfcp/bridge-reminders/transport";
import type { BridgeDatabase } from "./db/database.js";
import type { Holds } from "./db/holds.js";
import type { Journal } from "./db/journal.js";

export function markerUrl(instanceId: string, resourceId: string): string {
  return `${MARKER_PREFIX}${encodeURIComponent(instanceId)}?r=${encodeURIComponent(resourceId)}`;
}

export function parseMarker(
  url: string,
): { readonly instance: string; readonly resource: string } | undefined {
  if (!url.startsWith(MARKER_PREFIX)) return undefined;
  const rest = url.slice(MARKER_PREFIX.length);
  const q = rest.indexOf("?");
  if (q < 0) return undefined;
  const resource = new URLSearchParams(rest.slice(q + 1)).get("r");
  if (resource === null) return undefined;
  return { instance: decodeURIComponent(rest.slice(0, q)), resource };
}

export type OwnershipVerdict =
  | { readonly state: "ok" }
  | { readonly state: "incomplete" }
  | { readonly state: "foreign"; readonly instances: readonly string[] }
  | { readonly state: "lost" }
  /** Before bootstrap created a marker: no own marker expected yet. */
  | { readonly state: "free" };

/** Markers for `resourceId` across all lists: whose, and whether ours is there. */
export async function inspectMarkers(
  transport: RemindersTransport,
  instanceId: string,
  resourceId: string,
  expectOwn: boolean,
): Promise<OwnershipVerdict> {
  const found = await transport.find({ urlPrefix: MARKER_PREFIX }, "all");
  if (!found.complete) return { state: "incomplete" };
  const markers = found.items
    .map((i) => (i.linkUrl === undefined ? undefined : parseMarker(i.linkUrl)))
    .filter(
      (m): m is { instance: string; resource: string } =>
        m !== undefined && m.resource === resourceId,
    );
  const foreign = [
    ...new Set(markers.filter((m) => m.instance !== instanceId).map((m) => m.instance)),
  ];
  if (foreign.length > 0) return { state: "foreign", instances: foreign };
  const own = markers.some((m) => m.instance === instanceId);
  if (!expectOwn) return { state: "free" };
  return own ? { state: "ok" } : { state: "lost" };
}

interface BoundRow {
  readonly id: string;
  readonly resource_id: string;
}

/**
 * Applies the ownership check to the bindings that have a marker (pending_dry_run, active) and
 * remembers which are checked since the last start or wake (`ownership_checked`, §5.3).
 */
export class OwnershipGuard {
  readonly #checked = new Set<string>();

  constructor(
    private readonly db: BridgeDatabase,
    private readonly holds: Holds,
    private readonly journal: Journal,
    private readonly transport: RemindersTransport,
    private readonly instanceId: string,
  ) {}

  /** After start or wake: nothing is checked until the next check. */
  reset(): void {
    this.#checked.clear();
  }

  isChecked(bindingId: string): boolean {
    return this.#checked.has(bindingId);
  }

  async checkAll(): Promise<ReadonlyMap<string, OwnershipVerdict>> {
    const rows = this.db
      .prepare(
        "SELECT id, resource_id FROM bindings WHERE state IN ('pending_dry_run','active') ORDER BY id",
      )
      .all() as BoundRow[];
    const out = new Map<string, OwnershipVerdict>();
    for (const r of rows) out.set(r.id, await this.check(r.id, r.resource_id));
    return out;
  }

  async check(bindingId: string, resourceId: string): Promise<OwnershipVerdict> {
    const v = await inspectMarkers(this.transport, this.instanceId, resourceId, true);
    this.#checked.delete(bindingId);
    switch (v.state) {
      case "incomplete":
        break;
      case "foreign":
        if (this.holds.set(bindingId, "foreign_bridge", { instances: v.instances }))
          this.journal.append("warn", "ownership.foreign_bridge", {
            bindingId,
            params: {
              text: "Another bridge marks this section in your Reminders; this bridge stops writing (one bridge per Apple ID).",
              ...{ instances: v.instances },
            },
          });
        break;
      case "lost":
        this.holds.lift(bindingId, "foreign_bridge");
        if (this.holds.set(bindingId, "ownership_lost"))
          this.journal.append("warn", "ownership.lost", {
            bindingId,
            params: {
              text: "This bridge's marker is gone from Reminders; the bridge stops writing. If the Mac was replaced, finish the takeover; otherwise bind again.",
            },
          });
        break;
      case "ok":
      case "free":
        if (this.holds.lift(bindingId, "foreign_bridge"))
          this.journal.append("info", "ownership.foreign_gone", {
            bindingId,
            params: { text: "The other bridge's marker is gone." },
          });
        if (!this.holds.has(bindingId, "ownership_lost")) this.#checked.add(bindingId);
        break;
    }
    return v;
  }
}
