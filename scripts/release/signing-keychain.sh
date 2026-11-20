#!/bin/bash
# A throwaway keychain with the release chain's code-signing identity (E-052, R-601 §5), added to
# the user's keychain search list (codesign finds identities only there). For CI runners: the
# login keychain is never touched. Prints the identity's SHA-1 (what codesign --sign takes).
#
#   scripts/release/signing-keychain.sh developer-id <keychain>
#       imports DEVELOPER_ID_P12_BASE64 (password DEVELOPER_ID_P12_PASSWORD): the environment
#       `release`'s secrets, which need the owner's approval (E-057)
#   scripts/release/signing-keychain.sh dev <keychain>
#       a new self-signed "LFCP Bridge Dev" code-signing certificate (the dry run before Developer
#       ID, E3): signs like Developer ID, cannot be notarized
#
# The keychain's password is random and only lives in this process; delete the keychain with
# `security delete-keychain <keychain>` at the end of the job.
set -euo pipefail
MODE="${1:?usage: signing-keychain.sh developer-id|dev <keychain>}"
KC="${2:?usage: signing-keychain.sh developer-id|dev <keychain>}"
OPENSSL=/usr/bin/openssl   # LibreSSL: its PKCS#12 is what `security import` reads
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

pass="$("$OPENSSL" rand -hex 24)"
security create-keychain -p "$pass" "$KC"
security set-keychain-settings "$KC"   # no lock timeout
security unlock-keychain -p "$pass" "$KC"

case "$MODE" in
  developer-id)
    : "${DEVELOPER_ID_P12_BASE64:?no DEVELOPER_ID_P12_BASE64 (environment release, E-057)}"
    : "${DEVELOPER_ID_P12_PASSWORD:?no DEVELOPER_ID_P12_PASSWORD (environment release, E-057)}"
    printf '%s' "$DEVELOPER_ID_P12_BASE64" | base64 --decode > "$tmp/id.p12"
    security import "$tmp/id.p12" -k "$KC" -P "$DEVELOPER_ID_P12_PASSWORD" -T /usr/bin/codesign >/dev/null
    ;;
  dev)
    cat > "$tmp/cert.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = LFCP Bridge Dev
O = LFCP bridge development
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
CNF
    "$OPENSSL" req -x509 -newkey rsa:2048 -nodes -days 30 -config "$tmp/cert.cnf" \
      -keyout "$tmp/key.pem" -out "$tmp/cert.pem" 2>/dev/null
    p12pass="$("$OPENSSL" rand -hex 16)"
    "$OPENSSL" pkcs12 -export -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -name "LFCP Bridge Dev" \
      -out "$tmp/id.p12" -passout "pass:$p12pass"
    security import "$tmp/id.p12" -k "$KC" -P "$p12pass" -T /usr/bin/codesign >/dev/null
    ;;
  *) echo "signing-keychain: unknown mode $MODE" >&2; exit 2 ;;
esac
# codesign may use the key without a prompt.
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$pass" "$KC" >/dev/null

list=()
while IFS= read -r line; do
  line="${line#"${line%%[![:space:]]*}"}"; line="${line%\"}"; line="${line#\"}"
  [ -n "$line" ] && list+=("$line")
done < <(security list-keychains -d user)
security list-keychains -d user -s "$KC" ${list[@]+"${list[@]}"}

# The one code-signing identity of the keychain (trusted or not: codesign does not need trust).
ids="$(security find-identity -p codesigning "$KC" | sed -n 's/^ *[0-9]*) \([0-9A-F]\{40\}\) .*/\1/p' | sort -u)"
if [ "$(printf '%s\n' "$ids" | grep -c .)" != 1 ]; then
  echo "signing-keychain: want one code-signing identity in $KC, found: ${ids:-none}" >&2
  exit 1
fi
security find-identity -p codesigning "$KC" | grep "$ids" | head -1 >&2
echo "$ids"
