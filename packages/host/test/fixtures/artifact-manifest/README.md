# Artifact manifest fixture (A§9.1)

The shared fixture of the release chain (E-052) and the write gate (E-051).

- `artifact-manifest.json`: the manifest `scripts/release/artifact-manifest.mjs build` writes, for
  the small bundle `fixtureBundle()` of `packages/host/test/artifact-manifest.test.ts` (fake Mach-O
  headers, a stand-in cdhash), signed with the test key. The test checks it byte for byte and pins
  its `manifestSha256`; `UPDATE_ARTIFACT_FIXTURE=1` rewrites it after a format change.
- `test-key.pem` / `test-key.pub`: an Ed25519 key for tests only (PKCS#8 PEM; the raw public key,
  base64). It is public in this repository: nothing trusts it outside tests.
