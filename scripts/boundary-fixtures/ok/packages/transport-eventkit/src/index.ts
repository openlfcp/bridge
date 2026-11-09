import type { RemindersTransport } from "@openlfcp/bridge-reminders/transport";
import { CAPS } from "@openlfcp/bridge-reminders/capabilities";
import { spawn } from "node:child_process";
export type T = RemindersTransport;
export const c = [CAPS, spawn];
