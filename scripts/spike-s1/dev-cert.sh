#!/bin/bash
# Spike S-1 (CI only): a throwaway keychain with a fresh self-signed code-signing certificate
# "LFCP Bridge Dev" (the recipe of helper/scripts/sign-dev.sh), added to the user search list.
#   scripts/spike-s1/dev-cert.sh <keychain-path>     prints the certificate's SHA-1
set -euo pipefail
KC="${1:?usage: dev-cert.sh <keychain-path>}"
ID="${SIGN_IDENTITY:-LFCP Bridge Dev}"
OPENSSL=/usr/bin/openssl   # LibreSSL: its PKCS#12 is what `security import` reads
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
pw="$("$OPENSSL" rand -hex 16)"
security create-keychain -p "$pw" "$KC"
security set-keychain-settings "$KC"
security unlock-keychain -p "$pw" "$KC"
cat > "$tmp/cert.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $ID
O = LFCP bridge development
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
CNF
"$OPENSSL" req -x509 -newkey rsa:2048 -nodes -days 30 -config "$tmp/cert.cnf" \
  -keyout "$tmp/key.pem" -out "$tmp/cert.pem" 2>/dev/null
"$OPENSSL" pkcs12 -export -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -name "$ID" \
  -out "$tmp/id.p12" -passout "pass:$pw"
security import "$tmp/id.p12" -k "$KC" -P "$pw" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$pw" "$KC" >/dev/null 2>&1
existing=()
while IFS= read -r l; do
  l="${l#"${l%%[![:space:]]*}"}"; l="${l%\"}"; l="${l#\"}"
  [ -n "$l" ] && existing+=("$l")
done < <(security list-keychains -d user)
security list-keychains -d user -s "$KC" ${existing[@]+"${existing[@]}"}
security find-certificate -c "$ID" -Z "$KC" | sed -n 's/^SHA-1 hash: //p'
