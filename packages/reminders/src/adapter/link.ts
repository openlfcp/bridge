// The link a projected reminder carries (D-010 §3, O5):
// `lfcp://task/<TaskId>?s=<ResourceId>&b=<instance8>`. `s` is the section,
// `b` the first 8 characters of the bridge instance that made it —
// diagnostics, not ownership. The ownership marker's URL is
// `lfcp://bridge/<bridgeInstanceId>?r=<ResourceId>`.

import { MARKER_PREFIX, TASK_LINK_PREFIX } from "../values.js";

export interface TaskLink {
  readonly taskId: string;
  /** The section (ResourceId, hex); undefined when the URL has none. */
  readonly section?: string;
  /** The bridge instance prefix; undefined when the URL has none. */
  readonly bridge?: string;
}

/** The bridge instance prefix in links: 8 characters. */
export const instance8 = (bridgeInstanceId: string): string => bridgeInstanceId.slice(0, 8);

export function taskLink(taskId: string, section: string, bridgeInstanceId: string): string {
  return `${TASK_LINK_PREFIX}${encodeURIComponent(taskId)}?s=${section}&b=${instance8(bridgeInstanceId)}`;
}

/** A task link's parts; undefined for any other URL (a marker, a person's https link, none). */
export function parseTaskLink(url: string | undefined): TaskLink | undefined {
  if (url === undefined || !url.startsWith(TASK_LINK_PREFIX)) return undefined;
  const rest = url.slice(TASK_LINK_PREFIX.length);
  const q = rest.indexOf("?");
  const id = q < 0 ? rest : rest.slice(0, q);
  if (id === "" || id.includes("/")) return undefined;
  let taskId: string;
  try {
    taskId = decodeURIComponent(id);
  } catch {
    return undefined;
  }
  const params = new URLSearchParams(q < 0 ? "" : rest.slice(q + 1));
  const section = params.get("s") ?? undefined;
  const bridge = params.get("b") ?? undefined;
  return Object.freeze({
    taskId,
    ...(section === undefined ? {} : { section }),
    ...(bridge === undefined ? {} : { bridge }),
  });
}

export function markerUrl(bridgeInstanceId: string, section: string): string {
  return `${MARKER_PREFIX}${bridgeInstanceId}?r=${section}`;
}
