#!/bin/bash
# Development signing for LFCP Reminders Helper.app (D-010 r4 §8.2, B5: no Developer ID yet).
#
# Ad-hoc signatures change with every build, so TCC treats every build as a new app and asks for
# Reminders access again. A stable self-signed code-signing certificate keeps the designated
# requirement (identifier + certificate) the same across rebuilds.
#
#   scripts/sign-dev.sh --login-keychain   # first time: create "LFCP Bridge Dev" in the login keychain, build, sign
#   scripts/sign-dev.sh                    # later: sign with the existing certificate (reads the keychain only)
#   SIGN_KEYCHAIN=/path/x.keychain-db scripts/sign-dev.sh   # another keychain (tests)
#   NO_BUILD=1 scripts/sign-dev.sh         # sign an existing build only
#
# Without --login-keychain the script never adds anything to the login keychain: if the certificate
# is missing there, it stops and says so.
#
# The certificate is self-signed and not trusted system-wide; codesign does not need trust to sign,
# and TCC compares the designated requirement. If codesign refuses the identity, trust it for code
# signing once: Keychain Access → the certificate → Trust → Code Signing: Always Trust.
# The first signing may ask "codesign wants to use the key …": answer "Always Allow".
set -euo pipefail
cd "$(dirname "$0")/.."
IDENTITY="${SIGN_IDENTITY:-LFCP Bridge Dev}"
LOGIN_KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
KEYCHAIN="${SIGN_KEYCHAIN:-$LOGIN_KEYCHAIN}"
OPENSSL="${OPENSSL:-/usr/bin/openssl}"   # LibreSSL: its PKCS#12 is what `security import` reads
APP="${OUT:-build}/LFCP Reminders Helper.app"

allow_login=0
for arg in "$@"; do
  case "$arg" in
    --login-keychain) allow_login=1 ;;
    -h | --help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "sign-dev: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if security find-certificate -c "$IDENTITY" "$KEYCHAIN" >/dev/null 2>&1; then
  echo "== certificate \"$IDENTITY\" already in $KEYCHAIN"
else
  if [ "$KEYCHAIN" = "$LOGIN_KEYCHAIN" ] && [ "$allow_login" != 1 ]; then
    echo "sign-dev: \"$IDENTITY\" is not in the login keychain, and this script does not add to it" >&2
    echo "  without consent. To create it there once, run:  scripts/sign-dev.sh --login-keychain" >&2
    echo "  (or set SIGN_KEYCHAIN to another keychain)" >&2
    exit 3
  fi
  echo "== creating self-signed code-signing certificate \"$IDENTITY\" in $KEYCHAIN"
  tmp="$(mktemp -d /tmp/lfcp-sign.XXXXXX)"
  cleanup_tmp() { rm -f "$tmp/key.pem" "$tmp/id.p12" "$tmp/cert.pem" "$tmp/cert.cnf"; rmdir "$tmp" 2>/dev/null || true; }
  # The private key exists on disk only for these few commands.
  trap cleanup_tmp EXIT
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
  cleanup_tmp
  trap - EXIT
  echo "== imported; SHA-1: $(security find-certificate -c "$IDENTITY" -Z "$KEYCHAIN" | sed -n 's/^SHA-1 hash: //p')"
fi

# codesign finds identities only in the keychain search list: add a keychain that is not there for
# the duration of the signing, then restore the list exactly. Paths are kept as array elements
# (they may contain spaces); the restore is a function, not shell code built from the paths.
search_list=()
while IFS= read -r line; do
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%\"}"
  line="${line#\"}"
  [ -n "$line" ] && search_list+=("$line")
done < <(security list-keychains -d user)
in_list=0
for k in ${search_list[@]+"${search_list[@]}"}; do
  [ "$k" = "$KEYCHAIN" ] && in_list=1
done
restore_search_list() { security list-keychains -d user -s ${search_list[@]+"${search_list[@]}"}; }
if [ "$in_list" = 0 ]; then
  security list-keychains -d user -s ${search_list[@]+"${search_list[@]}"} "$KEYCHAIN"
  trap restore_search_list EXIT
fi

if [ "${NO_BUILD:-0}" != "1" ]; then
  SIGN_IDENTITY="$IDENTITY" SIGN_KEYCHAIN="$KEYCHAIN" scripts/build-app.sh
else
  codesign --force --sign "$IDENTITY" --keychain "$KEYCHAIN" "$APP"
  codesign --verify --strict --verbose=1 "$APP"
fi
echo "== designated requirement (must stay the same across rebuilds):"
codesign -d -r- "$APP" 2>&1 | sed -n 's/^designated => /  /p'
