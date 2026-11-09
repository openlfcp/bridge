// A liveness probe of the section session's connection (D-010 PR 3b), as the
// Obsidian plugin has it (src/core/lfcp/liveness.ts): after a Mac sleeps or a
// network changes under it, a WebSocket can look open while nothing reaches
// it, and the SDK notices only after three heartbeat intervals without a
// message (LFCP-WIRE-01 §38: 90 s at the reference server's 30 s), the
// sections looking live meanwhile.
//
// While the session is READY, when nothing arrived for `idleMs` the probe
// sends a PING of its own; any LFCP message counts as the answer (§38). With
// nothing within `replyMs` the connection is taken for dead and the host
// drops it and reconnects, as after any loss.

import type { WebSocketFactory, WebSocketLike } from "@openlfcp/client";
import { createMessage, encodeMessage } from "@openlfcp/wire";

export interface LivenessOptions {
  /** Silence after which a PING is sent (default 15 s). */
  readonly idleMs: number;
  /** How long the PING waits for any message (default 5 s). */
  readonly replyMs: number;
}

export const LIVENESS: LivenessOptions = Object.freeze({ idleMs: 15_000, replyMs: 5_000 });

export class LivenessProbe {
  #socket: WebSocketLike | null = null;
  #lastReceived = 0;
  #pingAt: number | null = null;

  constructor(
    private readonly base: WebSocketFactory,
    private readonly now: () => number,
    private readonly options: LivenessOptions = LIVENESS,
    private readonly random: (n: number) => Uint8Array = (n) =>
      crypto.getRandomValues(new Uint8Array(n)),
  ) {}

  /** The factory for the SDK: the base sockets, each message's arrival noted. */
  readonly factory: WebSocketFactory = (url, protocols) => {
    const real = this.base(url, protocols);
    this.#socket = real;
    this.#lastReceived = this.now();
    this.#pingAt = null;
    return tapMessages(real, () => {
      if (this.#socket !== real) return;
      this.#lastReceived = this.now();
      this.#pingAt = null;
    });
  };

  /**
   * On the session's clock: false when the connection is taken for dead (a
   * PING unanswered for `replyMs`). `ready`: the session is READY; before
   * that the SDK's handshake timeout applies.
   */
  tick(now: number, ready: boolean): boolean {
    const socket = this.#socket;
    if (!ready || socket === null) {
      this.#pingAt = null;
      return true;
    }
    if (this.#pingAt !== null) {
      if (now - this.#pingAt < this.options.replyMs) return true;
      this.#pingAt = null;
      this.#socket = null;
      return false;
    }
    if (now - this.#lastReceived >= this.options.idleMs) {
      this.#pingAt = now;
      try {
        socket.send(encodeMessage(createMessage("PING", { payload: this.random(8) })));
      } catch {
        // A socket that cannot send is as good as dead: the reply wait decides.
      }
    }
    return true;
  }
}

/** `real` with each received message passed to `heard` before the SDK's handler sees it. */
export function tapMessages(real: WebSocketLike, heard: (data: unknown) => void): WebSocketLike {
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
    send: (data) => real.send(data),
    close: (code, reason) => real.close(code, reason),
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
      return real.onmessage;
    },
    set onmessage(fn) {
      real.onmessage =
        fn === null
          ? null
          : (ev) => {
              heard(ev.data);
              fn(ev);
            };
    },
  };
}
