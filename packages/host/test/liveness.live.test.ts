// The section session's liveness against the Rust reference server (D-010
// PR 3b): wake reconnects in a new generation; a connection that silently
// stops (a half-open socket after a sleep) is found by the probe and made
// again; networkBack connects at once; access_checked_now per generation.
// Skipped without LFCP_SERVER_BIN.

import {
  connectionNetwork,
  platformWebSocket,
  type WebSocketFactory,
  type WebSocketLike,
} from "@openlfcp/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AccessRecord, type AccessStore, AccessTracker, SectionHost } from "../src/index.js";
import { installation, memory, ownedSection } from "./support/lfcp.js";
import { type LiveServer, serverSkip, startServer, waitFor } from "./support/server.js";

const skip = serverSkip();
let server: LiveServer | undefined;
beforeAll(async () => {
  if (skip === undefined) server = await startServer();
}, 60_000);
afterAll(async () => {
  await server?.dispose();
});

/** Platform sockets of which the current one can be made silent: nothing in, nothing out, still "open". */
function silenceable() {
  let silentSocket: number | undefined;
  let opened = 0;
  const factory: WebSocketFactory = (url, protocols) => {
    opened++;
    const me = opened;
    const silent = () => silentSocket === me;
    const real = platformWebSocket()(url, protocols);
    let onmessage: WebSocketLike["onmessage"] = null;
    real.onmessage = (ev) => {
      if (!silent()) onmessage?.(ev);
    };
    return {
      get binaryType() {
        return real.binaryType;
      },
      set binaryType(v: string) {
        real.binaryType = v;
      },
      get protocol() {
        return real.protocol;
      },
      send: (d) => {
        if (!silent()) real.send(d);
      },
      close: (c, r) => real.close(c, r),
      get onopen() {
        return real.onopen;
      },
      set onopen(fn) {
        real.onopen = fn;
      },
      get onclose() {
        return real.onclose;
      },
      set onclose(fn) {
        real.onclose = fn;
      },
      get onerror() {
        return real.onerror;
      },
      set onerror(fn) {
        real.onerror = fn;
      },
      get onmessage() {
        return onmessage;
      },
      set onmessage(fn) {
        onmessage = fn;
      },
    };
  };
  return {
    factory,
    opened: () => opened,
    /** Silences the socket open now (a half-open connection after a sleep). */
    silenceCurrent: () => {
      silentSocket = opened;
    },
  };
}

const memoryStore = (): AccessStore => {
  const m = new Map<string, AccessRecord>();
  return { get: (r) => m.get(String(r)), put: (r, v) => void m.set(String(r), v) };
};

describe.skipIf(skip !== undefined)("SectionHost liveness, live", { timeout: 120_000 }, () => {
  it("wake, a silent connection, networkBack; access_checked_now follows the generations", async () => {
    const url = (server as LiveServer).url;
    const A = installation();
    const a = memory();
    const { R, genesis } = await ownedSection(A, a.storage, a.secrets, url);
    const ch = await connectionNetwork({ now: Date.now }).connect(A.signer, url);
    expect((await ch.host(genesis)).kind).toBe("ack");
    ch.close();
    const ws = silenceable();
    const host = new SectionHost({
      url,
      installation: A,
      ...a,
      webSocket: ws.factory,
      tickMs: 100,
      reconnect: () => 60_000,
      liveness: { idleMs: 400, replyMs: 400 },
    });
    const access = new AccessTracker({
      source: host,
      store: memoryStore(),
      checkRevocation: async () => "active",
    });
    await host.open(R);
    host.start();
    await waitFor("live", () => host.isLive(R));
    await waitFor("access checked", () => access.accessCheckedNow(R));
    expect([host.generation, ws.opened()]).toEqual([0, 1]);

    // wake: not trusted, a new generation, a new connection at once (not after 60 s).
    host.wake();
    expect([host.isLive(R), access.accessCheckedNow(R)]).toEqual([false, false]);
    await waitFor("live after wake", () => host.isLive(R), 20_000);
    await waitFor("access checked after wake", () => access.accessCheckedNow(R));
    expect(host.generation).toBe(1);
    expect(ws.opened()).toBe(2);

    // The connection goes silent while "open": the probe drops it and reconnects.
    const lost: string[] = [];
    const off = host.onLiveChange((c) => {
      if (c.resource !== null && !c.live) lost.push(c.reason ?? "state");
    });
    ws.silenceCurrent();
    // The probe drops it (PING after 400 ms, no answer for 400 ms): a new generation.
    await waitFor("a new generation (silent)", () => host.generation === 2, 10_000);
    off();
    expect(lost).toContain("disconnect");
    await waitFor("live after the probe", () => host.isLive(R), 20_000);
    expect(host.generation).toBe(2);
    expect(ws.opened()).toBe(3);

    // The server is down; it comes back; networkBack connects at once.
    await (server as LiveServer).stop();
    await waitFor("down", () => !host.connected);
    const before = ws.opened();
    await (server as LiveServer).restart();
    // The policy waits 60 s; networkBack does not.
    await new Promise((r) => setTimeout(r, 500));
    host.networkBack();
    await waitFor("live after networkBack", () => host.isLive(R), 20_000);
    expect(ws.opened()).toBeGreaterThan(before);
    access.close();
    await host.stop();
  });
});
