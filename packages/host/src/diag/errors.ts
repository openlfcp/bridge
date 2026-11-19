// Structured error codes (A§11, E20): what the journal and the intents keep of an error instead of
// String(error). A message carries paths, titles, URLs and server texts; a code carries none of
// them. The code is the error's own `code` when it is a machine token (errno, transport and SDK
// codes), else its class name, else "error". Never its message, never its cause's message.

/** A machine token: what may stand as a code in the journal and in a diagnostics export. */
export const CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,47}$/;

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
