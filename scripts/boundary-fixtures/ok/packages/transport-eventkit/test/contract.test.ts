import { transportContract } from "@openlfcp/bridge-reminders/test-support";
import type { RemindersTransport } from "@openlfcp/bridge-reminders/transport";
export const t: [typeof transportContract, RemindersTransport?] = [transportContract];
