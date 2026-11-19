// Types of scripts/check-release-deps.mjs for the tests.

interface Manifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  pnpm?: { overrides?: Record<string, string> };
}

export function releaseDepsProblems(input: {
  manifests: ReadonlyArray<readonly [string, Manifest]>;
  sdkLock: boolean;
  workspaceYaml?: string;
}): string[];

export function readManifests(root: string): Array<[string, Manifest]>;
