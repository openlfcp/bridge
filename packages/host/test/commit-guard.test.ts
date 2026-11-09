// The guard of a commit binding (D-010 §5.8, r3 P2-5), on its own.

import type { CommitBinding, StagedOperation } from "@openlfcp/client";
import { describe, expect, it } from "vitest";
import { BasisChangedError, guardCommitBinding, UnguardedCommitError } from "../src/index.js";

function inner() {
  const staged: (readonly unknown[])[] = [];
  const binding: CommitBinding<unknown> = {
    codec: {} as never,
    stage(intents) {
      staged.push(intents);
      return null as StagedOperation<unknown> | null;
    },
  };
  return { binding, staged };
}

describe("guardCommitBinding", () => {
  it("refuses a stage that no guarded call registered: no bypass", () => {
    const i = inner();
    const g = guardCommitBinding(i.binding);
    expect(() => g.binding.stage(["x"])).toThrow(UnguardedCommitError);
    expect(i.staged).toEqual([]);
  });

  it("runs the check inside stage, before the inner stage; a failed check writes nothing", async () => {
    const i = inner();
    const g = guardCommitBinding(i.binding);
    const ok = await g.guarded(
      ["a"],
      () => true,
      async (batch) => g.binding.stage(batch),
    );
    expect(ok.staged).toBe(true);
    expect(i.staged).toEqual([["a"]]);
    await expect(
      g.guarded(
        ["b"],
        () => "title changed",
        async (batch) => g.binding.stage(batch),
      ),
    ).rejects.toThrow(BasisChangedError);
    await expect(
      g.guarded(
        ["b"],
        () => false,
        async (batch) => g.binding.stage(batch),
      ),
    ).rejects.toMatchObject({ code: "BASIS_CHANGED" });
    expect(i.staged).toEqual([["a"]]);
  });

  it("gives every call its own array and guard, also for one array passed twice at once", async () => {
    const i = inner();
    const g = guardCommitBinding(i.binding);
    const shared = ["same"];
    const batches: (readonly unknown[])[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // Both calls are registered before either stages.
    const first = g.guarded(
      shared,
      () => true,
      async (batch) => {
        batches.push(batch);
        await gate;
        return g.binding.stage(batch);
      },
    );
    const second = g.guarded(
      shared,
      () => false,
      async (batch) => {
        batches.push(batch);
        await gate;
        return g.binding.stage(batch);
      },
    );
    release();
    const [a, b] = await Promise.allSettled([first, second]);
    expect(a.status).toBe("fulfilled");
    expect(b.status === "rejected" && b.reason).toBeInstanceOf(BasisChangedError);
    expect(batches[0]).not.toBe(batches[1]);
    expect(batches[0]).not.toBe(shared);
    expect(Object.isFrozen(batches[0])).toBe(true);
    // Once done, a batch is no longer registered: staging it again is a bypass.
    expect(() => g.binding.stage(batches[0] as readonly unknown[])).toThrow(UnguardedCommitError);
  });

  it("a commit that never reaches stage (a known receipt) reports staged: false", async () => {
    const g = guardCommitBinding(inner().binding);
    expect(
      await g.guarded(
        ["r"],
        () => false,
        async () => "receipt",
      ),
    ).toEqual({
      result: "receipt",
      staged: false,
    });
  });
});
