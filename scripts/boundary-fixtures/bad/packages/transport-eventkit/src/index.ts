import { PACKAGE } from "@openlfcp/bridge-reminders";
import { plan } from "@openlfcp/bridge-reminders/reconcile";
const host = await import("@openlfcp/bridge");
export const p = [PACKAGE, plan, host];
