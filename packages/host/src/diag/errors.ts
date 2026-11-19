// Structured error codes (A§11, E20): what the journal and the intents keep of an error instead of
// String(error). A message carries paths, titles, URLs and server texts; a code carries none of
// them. The code is the error's own `code` when it is a known one (codes.ts: errno, transport,
// helper, SDK, SQLite), else its class name when that is known, else "error". Never its message,
// never its cause's, never a code or a class name outside those lists — whatever it looks like.

import { ERROR_CLASSES, KNOWN_CODES } from "./codes.js";

/** The structured code of an error. */
export function errorCode(e: unknown): string {
  if (typeof e === "object" && e !== null) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && KNOWN_CODES.has(code)) return code;
    const name = (e as { name?: unknown }).name;
    if (typeof name === "string" && ERROR_CLASSES.has(name)) return name;
  }
  return "error";
}
