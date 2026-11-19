# The SDK pin

Until `@openlfcp/*` 0.7.0 is on npm, the bridge builds against a commit of openlfcp/sdk-ts's `main`
(the service-control client, E-030). openlfcp/obsidian uses the same scheme and the same script.

- `sdk-ts.lock` names the commit, as `server.lock` does for the server.
- `node scripts/sdk-ts-pack.mjs [--checkout DIR]` exports that commit from a clone of sdk-ts (default
  `../sdk-ts` next to this repository; its working tree, branch and line-ending settings do not
  matter) into a temporary directory, installs and builds it there, and packs its eight packages into
  `vendor/sdk-ts/` (gitignored). The packing is byte-identical on every system, `core.autocrlf` or
  not: the files are the committed bytes (`git archive`, no line-ending conversion); each package's
  `workspace:` ranges are rewritten before `pnpm pack` (which writes them in no stable order); and
  each tarball is written again with its entries sorted, fixed mode, owner and time, stored
  uncompressed in gzip (`pnpm pack`'s file order and gzip bytes differ by system). Its self-test
  runs with `pnpm lint`.
- `packages/host/package.json` takes each SDK package as a `file:../../vendor/sdk-ts/…tgz` tarball,
  and the root `pnpm.overrides` sends every `@openlfcp/*` SDK package, the dependencies of the
  packages themselves included, to the tarballs, never to npm. `pnpm-lock.yaml` records each
  tarball's integrity: `sdk-ts.lock` pins the commit, the pnpm lockfile its bytes, and
  `pnpm install --frozen-lockfile` fails if a tarball differs.
- CI (`ci.yml`, `app.yml`, `helper.yml`) checks out sdk-ts at the commit in `sdk-ts.lock` under
  `vendor/sdk-ts-src` and runs the script before `pnpm install`.
- A release is never built from the pin: `scripts/check-release-deps.mjs` refuses `sdk-ts.lock`, any
  `@openlfcp/*` dependency that is not an exact npm version (the repository's own `workspace:`
  packages aside) and any `@openlfcp/*` override to something else. `helper/scripts/sign-release.sh`
  runs it before anything is looked up or signed, and so does the `package` job of `app.yml` on a
  tag; the release chain (E-052) calls the same script.

## Building from source

```sh
git clone https://github.com/openlfcp/sdk-ts.git ../sdk-ts   # once; any clone with the commit
node scripts/sdk-ts-pack.mjs                                  # packs the SDK into vendor/sdk-ts/
pnpm install --frozen-lockfile
```

After a `git pull` that changes `sdk-ts.lock`, run `git -C ../sdk-ts fetch` and the script again
before `pnpm install`.

## Moving the pin

Fetch the new commit into the sdk-ts clone, update `sdk-ts.lock`, run the script and `pnpm install`,
and commit `sdk-ts.lock`, `package.json` files (if the version changed) and `pnpm-lock.yaml`
together. Once the SDK is published, remove `sdk-ts.lock`, the `file:` dependencies and the
overrides' tarballs, and take the exact npm versions again, in their own commit; the CI steps that
pack the SDK go in the same commit.
