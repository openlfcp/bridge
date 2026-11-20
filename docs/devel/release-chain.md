# Release chain (E-052)

`.github/workflows/release.yml` turns one commit into one set of release files: the DMG,
`artifact-manifest.json` (A§9.1) and its public key, `SHA256SUMS`, attached to a **draft** GitHub
Release. Later steps (certify, E-055; publication, E-063) copy these files; nothing is rebuilt.

## Order (A§9.2)

1. Build and sign from the inside out (`scripts/app/package-app.sh` with `PACKAGE_DMG=0`):
   `better_sqlite3.node` → `node` → helper → the bundle (shell, resource seal), hardened runtime.
2. Notarize and staple the app (`scripts/release/notarize.sh`; Developer ID only).
3. `artifact-manifest.json` (`scripts/release/artifact-manifest.mjs build`), outside the bundle.
   The step records every cdhash before and after (`cdhashes`) and fails when they differ, then
   checks the bundle against the manifest (`check`).
4. DMG of the same app (`scripts/app/make-dmg.sh`), signed; notarized and stapled with Developer ID.
5. The app inside the mounted DMG is checked against the manifest again.
6. Draft release: `dry-run-<run>-<attempt>` or `candidate-<version>-<run>`. Never published by
   the workflow, never a `v*` tag.

## Modes

| | `dry-run` (push of the chain's files, or by hand) | `developer-id` (by hand) |
|---|---|---|
| Identity | a throwaway self-signed "LFCP Bridge Dev" (`signing-keychain.sh dev`) | Developer ID Application from the environment `release` |
| Notarization, staple | skipped, with a notice | `notarytool submit --wait`, `stapler`, `spctl` |
| Manifest key | ephemeral, generated in the job | `ARTIFACT_MANIFEST_ED25519_KEY` |
| SDK | the pin of `sdk-ts.lock` | npm only (`check-release-deps.mjs`) |
| Secrets read | none | the environment `release` (owner's approval, E-057) |

Secrets of the environment `release` (E-057): `DEVELOPER_ID_P12_BASE64`,
`DEVELOPER_ID_P12_PASSWORD`, `NOTARY_API_KEY_P8_BASE64`, `NOTARY_KEY_ID`, `NOTARY_ISSUER_ID`,
`ARTIFACT_MANIFEST_ED25519_KEY` (PKCS#8 PEM; `artifact-manifest.mjs keygen` makes one).

## The manifest

Format: `packages/host/src/artifact/manifest.ts` (header comment). The file is canonical JSON
(RFC 8785) `{manifest, signature}`; the Ed25519 signature and `manifestSha256` are over the
canonical bytes of `manifest`. `slices.<arch>.shell` is the shell's cdhash (`artifactSliceId`),
`nested[]` the cdhash of every other Mach-O of that slice; `files[]` lists every file except
`Contents/_CodeSignature/*` and the staple ticket `Contents/CodeResources`, with `{path, symlink}`
for a symbolic link. The shared fixture for readers (E-051) is
`packages/host/test/fixtures/artifact-manifest/`.
