/**
 * `@openlfcp/bridge`: the host of lfcp-bridge (D-010 §1): the CLI, the
 * long-running process, the bridge database, the intent executor, the
 * guards and the LFCP side.
 */
export const PACKAGE = "@openlfcp/bridge";

export {
  type CliEnvironment,
  COMMANDS,
  type CommandInfo,
  main,
  USAGE,
  VERSION,
} from "./commands.js";
export { EXIT, type ExitCode } from "./exit.js";
