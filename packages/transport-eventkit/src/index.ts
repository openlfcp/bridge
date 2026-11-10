/**
 * The EventKit transport of lfcp-bridge (D-010 §4.2, §8): the Node side of
 * `LFCP Reminders Helper.app`. It imports only the adapter's transport
 * contract and capability declaration, never the host.
 */
export const PACKAGE = "@openlfcp/bridge-transport-eventkit";

export {
  EXECUTABLE,
  executableName,
  type HelperLink,
  HelperLostError,
  HelperProcess,
  type HelperProcessOptions,
} from "./link.js";
export {
  EventKitTransport,
  EventKitTransportError,
  type EventKitTransportOptions,
  statusOf,
  type WriteMode,
} from "./transport.js";
export {
  mapItem,
  mapList,
  mapWriteResponse,
  mapWritten,
  PROTOCOL,
  type WireEvent,
  type WireReady,
  type WireResponse,
} from "./wire.js";
