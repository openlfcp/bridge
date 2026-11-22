// The trusted Ed25519 public keys (raw, base64) of the certification key that signs the artifact
// manifest and the public certification manifest (A§9.1–9.2). Built into the host's bundle, so
// the shell's resource seal covers them (check (3) of the gate). Empty: no manifest verifies and
// every normal binding stays preview — the owner adds the key of the environment `release`
// (ARTIFACT_MANIFEST_ED25519_KEY, `artifact-manifest.mjs keygen` prints its public key).
export const TRUSTED_MANIFEST_KEYS: readonly string[] = Object.freeze([]);
