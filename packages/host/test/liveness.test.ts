// The liveness probe and the restartable reconnect (D-010 PR 3b).

import type { WebSocketLike } from "@openlfcp/client";
import { decodeMessage } from "@openlfcp/wire";
import { describe, expect, it } from "vitest";
import { cappedReconnect, LivenessProbe, restartableReconnect } from "../src/index.js";

function fakeSocket() {
  const sent: Uint8Array[] = [];
  const ws: WebSocketLike = {
    binaryType: "arraybuffer",
    protocol: "lfcp-1",
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: (d: Uint8Array) => sent.push(d),
    close: () => undefined,
  };
  return { ws, sent };
}

describe("LivenessProbe", () => {
  it("PINGs after idleMs of silence; any message answers; none within replyMs is a dead connection", () => {
    let t = 0;
    const s = fakeSocket();
    const probe = new LivenessProbe(
      () => s.ws,
      () => t,
      { idleMs: 1000, replyMs: 500 },
    );
    const ws = probe.factory("ws://127.0.0.1:1/v1/ws", ["lfcp-1"]);
    const got: unknown[] = [];
    ws.onmessage = (e) => got.push(e.data);
    // Not READY: nothing.
    t = 5000;
    expect(probe.tick(t, false)).toBe(true);
    expect(s.sent).toEqual([]);
    expect(probe.tick(t, true)).toBe(true);
    expect(s.sent).toHaveLength(1);
    expect(decodeMessage(s.sent[0] as Uint8Array, { maxMessageBytes: 1024 }).type).toBe("PING");
    // An answer (any message) reaches the SDK's handler and clears the wait.
    s.ws.onmessage?.({ data: new Uint8Array([1]) });
    expect(got).toHaveLength(1);
    t += 400;
    expect(probe.tick(t, true)).toBe(true);
    expect(s.sent).toHaveLength(1);
    // Silence again: a PING, no answer within replyMs → dead.
    t += 1000;
    expect(probe.tick(t, true)).toBe(true);
    expect(s.sent).toHaveLength(2);
    t += 499;
    expect(probe.tick(t, true)).toBe(true);
    t += 1;
    expect(probe.tick(t, true)).toBe(false);
  });
});

describe("reconnect", () => {
  it("1 s doubling to 15 s within ±20 %; restart() counts from the start again", () => {
    const mid = cappedReconnect(() => 0.5);
    expect([1, 2, 3, 4, 5, 6, 9].map((a) => mid(a))).toEqual([
      1000, 2000, 4000, 8000, 15_000, 15_000, 15_000,
    ]);
    expect(cappedReconnect(() => 0)(1)).toBe(800);
    expect(cappedReconnect(() => 1)(1)).toBe(1200);
    const r = restartableReconnect(mid);
    expect([r.policy(1), r.policy(2), r.policy(3)]).toEqual([1000, 2000, 4000]);
    r.restart();
    expect([r.policy(4), r.policy(5)]).toEqual([1000, 2000]);
    // The SDK counts from 1 again after a READY: so does the policy.
    expect(r.policy(1)).toBe(1000);
  });
});
