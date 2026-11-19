// Spike S-1: a local Sparkle appcast for the N → N+1 update, EdDSA (Ed25519) as Sparkle 2 wants:
// SUPublicEDKey is the raw 32-byte public key in base64, sparkle:edSignature the signature of the
// whole archive in base64. Node's crypto instead of Sparkle's generate_keys/sign_update (no keychain).
//   node scripts/spike-s1/appcast.mjs keygen <private-key.pem>      prints SUPublicEDKey
//   node scripts/spike-s1/appcast.mjs item <archive> <url> <version> <short-version> <private-key.pem>
//                                                                     prints appcast.xml
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";

const [cmd, ...a] = process.argv.slice(2);
const publicKeyOf = (key) =>
  createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32).toString("base64");

if (cmd === "keygen" && a.length === 1) {
  const { privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(a[0], privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  console.log(publicKeyOf(privateKey));
} else if (cmd === "item" && a.length === 5) {
  const [archive, url, version, short, keyFile] = a;
  const key = createPrivateKey(readFileSync(keyFile));
  const signature = sign(null, readFileSync(archive), key).toString("base64");
  console.log(`<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>LFCP Bridge (spike S-1)</title>
    <item>
      <title>${short}</title>
      <pubDate>${new Date().toUTCString()}</pubDate>
      <sparkle:version>${version}</sparkle:version>
      <sparkle:shortVersionString>${short}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>15.0</sparkle:minimumSystemVersion>
      <enclosure url="${url}" length="${statSync(archive).size}" type="application/octet-stream"
        sparkle:edSignature="${signature}"/>
    </item>
  </channel>
</rss>`);
} else {
  console.error(
    "usage: appcast.mjs keygen <key.pem> | item <archive> <url> <version> <short> <key.pem>",
  );
  process.exit(2);
}
