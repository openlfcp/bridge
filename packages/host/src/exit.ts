/** Exit codes of `lfcp-bridge` (D-010 §2.1). */
export const EXIT = Object.freeze({
  /** Done. */
  OK: 0,
  /** An internal error. */
  INTERNAL: 1,
  /** Bad arguments, or a command this build does not have yet. */
  USAGE: 2,
  /** A person has to decide or act (a conflict, a hold, a quarantine). */
  NEEDS_PERSON: 3,
  /** Not found: an installation, a binding, a conflict… */
  NOT_FOUND: 4,
  /** Stopped by a guard or by STOP. */
  STOPPED: 5,
} as const);

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
