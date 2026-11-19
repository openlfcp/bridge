// Types of scripts/sdk-ts-pack.mjs for the tests.

export function exportCommit(repo: string, commit: string, paths: readonly string[]): Buffer;
export function extractTar(tar: Buffer, dir: string): void;
