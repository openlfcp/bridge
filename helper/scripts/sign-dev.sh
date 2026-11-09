#!/bin/bash
# Development signing for LFCP Reminders Helper.app (D-010 r4 §8.2, B5: no Developer ID yet).
#
# Ad-hoc signatures change with every build, so TCC treats every build as a new app and asks for
# Reminders access again. A stable self-signed code-signing certificate keeps the designated
# requirement (identifier + certificate) the same across rebuilds.
#
#   scripts/sign-dev.sh            # create "LFCP Bridge Dev" in the login keychain if missing, build, sign
#   SIGN_KEYCHAIN=/path/x.keychain-db scripts/sign-dev.sh   # use another keychain (tests)
#   NO_BUILD=1 scripts/sign-dev.sh # sign an existing build only
#
# The certificate is self-signed and not trusted system-wide; codesign does not need trust to sign,
# and TCC compares the designated requirement. If codesign refuses the identity, trust it for code
# signing once: Keychain Access → the certificate → Trust → Code Signing: Always Trust.
# The first signing may ask "codesign wants to use the key …": answer "Always Allow".
set -euo pipefail
cd "$(dirname "$0")/.."
IDENTITY="${SIGN_IDENTITY:-LFCP Bridge Dev}"
KEYCHAIN="${SIGN_KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"
OPENSSL=/usr/bin/openssl   # LibreSSL: its PKCS#12 is what `security import` reads
APP="${OUT:-build}/LFCP Reminders Helper.app"

if security find-certificate -c "$IDENTITY" "$KEYCHAIN" >/dev/null 2>&1; then
  echo "== certificate \"$IDENTITY\" already in $KEYCHAIN"
else
  echo "== creating self-signed code-signing certificate \"$IDENTITY\" in $KEYCHAIN"
  tmp="$(mktemp -d /tmp/lfcp-sign.XXXXXX)"
  # The private key exists on disk only for these few commands.
  trap 'rm -f "$tmp/key.pem" "$tmp/id.p12" "$tmp/cert.pem" "$tmp/cert.cnf"; rmdir "$tmp" 2>/dev/null || true' EXIT
  cat > "$tmp/cert.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $IDENTITY
O = LFCP bridge development
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
CNF
  "$OPENSSL" req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -config "$tmp/cert.cnf" -keyout "$tmp/key.pem" -out "$tmp/cert.pem" 2>/dev/null
  pass="$("$OPENSSL" rand -hex 16)"
  "$OPENSSL" pkcs12 -export -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -name "$IDENTITY" \
    -out "$tmp/id.p12" -passout "pass:$pass"
  security import "$tmp/id.p12" -k "$KEYCHAIN" -P "$pass" -T /usr/bin/codesign >/dev/null
  rm -f "$tmp/key.pem" "$tmp/id.p12" "$tmp/cert.pem" "$tmp/cert.cnf"
  rmdir "$tmp"
  trap - EXIT
  echo "== imported; SHA-1: $(security find-certificate -c "$IDENTITY" -Z "$KEYCHAIN" | sed -n 's/^SHA-1 hash: //p')"
fi

# codesign finds identities only in the keychain search list: add a non-default keychain for the
# duration of the signing and put the list back afterwards.
orig_list="$(security list-keychains -d user | tr -d '"' | xargs)"
case " $orig_list " in
  *" $KEYCHAIN "*) ;;
  *)
    # shellcheck disable=SC2086
    security list-keychains -d user -s $orig_list "$KEYCHAIN"
    # shellcheck disable=SC2086
    trap 'security list-keychains -d user -s '"$orig_list" EXIT
    ;;
esac

if [ "${NO_BUILD:-0}" != "1" ]; then
  SIGN_IDENTITY="$IDENTITY" SIGN_KEYCHAIN="$KEYCHAIN" scripts/build-app.sh
else
  codesign --force --sign "$IDENTITY" --keychain "$KEYCHAIN" "$APP"
  codesign --verify --strict --verbose=1 "$APP"
fi
echo "== designated requirement (must stay the same across rebuilds):"
codesign -d -r- "$APP" 2>&1 | sed -n 's/^designated => /  /p'
