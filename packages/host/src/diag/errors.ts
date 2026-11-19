// Structured error codes (A§11, E20): what the journal and the intents keep of an error instead of
// String(error). A message carries paths, titles, URLs and server texts; a code carries none of
// them. The code is the error's own `code` when it is a machine token (errno, transport and SDK
// codes), else its class name, else "error". Never its message, never its cause's message.

/**
 * A machine code: what may stand as a code in the journal and in a diagnostics export. Only the
 * shapes code is written in — snake_case or dotted (`store_conflict`, `effect.lost`), an errno or
 * constant (`EPIPE`, `EXC_BAD_ACCESS`), an error class (`OutcomeUnknownError`) — never a single
 * word or mixed case, which a title can be.
 */
export const CODE =
  /^(?=.{1,48}$)(?:[a-z][a-z0-9]*(?:[_.-][a-z0-9]+)+|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*|[A-Z][A-Za-z0-9]*Error)$/;

/** The structured code of an error. */
export function errorCode(e: unknown): string {
  if (typeof e === "object" && e !== null) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && CODE.test(code)) return code;
    const name = (e as { name?: unknown }).name;
    if (typeof name === "string" && CODE.test(name) && name !== "Error") return name;
  }
  return "error";
}
