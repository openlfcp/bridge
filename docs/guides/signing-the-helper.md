# Signing the helper for a release

`LFCP Reminders Helper.app` is the only part of the bridge that macOS asks about: Reminders access
(TCC) belongs to it. A release build is signed with the owner's **Developer ID Application**
certificate, with the **hardened runtime**, and **notarized** by Apple, so it opens without a
Gatekeeper warning and keeps its Reminders permission across updates (B5).

Development builds keep using `helper/scripts/sign-dev.sh` (a self-signed certificate, no
notarization).

## What `sign-release.sh` does

    helper/scripts/sign-release.sh --identity "Developer ID Application: <Name> (<TEAMID>)" \
      --notarize --notary-profile lfcp-notary

1. Checks that the identity is in a keychain (`security find-identity`, read-only).
2. Builds the app for arm64 and x86_64 (`scripts/build-app.sh`; `--no-build` skips this).
3. Signs it: `codesign --options runtime --timestamp --entitlements Support/release.entitlements`.
   The only entitlement is `com.apple.security.personal-information.calendars`. Under the
   hardened runtime EventKit needs it for reminders too; without it the Reminders prompt never
   appears.
4. Verifies the signature, the identifier `org.openlfcp.bridge.reminders`, the runtime flag and
   the entitlement.
5. With `--notarize`:
   - zips the app (`ditto`);
   - submits it with `xcrun notarytool submit --wait`;
   - on `Accepted`, staples the ticket (`xcrun stapler staple`) and checks it (`stapler validate`,
     `spctl --assess`);
   - on anything else, prints the notary log and exits 4.

The script changes no keychain. It does not create, import, unlock or delete anything, and leaves
the keychain search list alone. The only exception is `--add-to-search-list` (with `--keychain`):
then it adds that keychain for the signing and restores the list exactly. Passwords are never
command-line arguments.

`helper/scripts/test-sign-release.sh` runs the script against stub `security`, `codesign`, `xcrun`,
`ditto` and `spctl`. It signs nothing and sends nothing; CI runs it in the `helper` job.

## Once: the Developer ID certificate

1. In Xcode → Settings → Accounts → your team → Manage Certificates…, click **+** and choose
   **Developer ID Application**. Or create it at developer.apple.com → Certificates and install it.
2. Check that it is there:

       security find-identity -v -p codesigning

   You should see a line `"Developer ID Application: <Name> (<TEAMID>)"`. Pass that text (or its
   SHA-1) as `--identity`.
3. The first signing may ask "codesign wants to use the key …": answer **Always Allow**.

## Once: credentials for notarization

Choose **one** of the two.

### A. Apple ID with an app-specific password (simplest)

1. Sign in at <https://account.apple.com> → Sign-In and Security → **App-Specific Passwords** →
   **+**, name it "lfcp notarytool". Copy the password (`xxxx-xxxx-xxxx-xxxx`). The account
   needs two-factor authentication.
2. Store it in your keychain as a notarytool profile. notarytool asks for the password; it is not
   typed on the command line:

       xcrun notarytool store-credentials lfcp-notary \
         --apple-id <your Apple ID e-mail> --team-id <TEAMID>

3. Use `--notary-profile lfcp-notary`. To revoke it later, delete the password on
   account.apple.com and the profile in Keychain Access (item "com.apple.gke.notary.tool").

### B. An App Store Connect API key (for automation)

1. App Store Connect → Users and Access → Integrations → **App Store Connect API** → Team Keys →
   **+**, with access **Developer**. Download `AuthKey_<KEYID>.p8`. It can be downloaded only once.
   Keep it outside the repository, readable only by you (`chmod 600`).
2. Note the **Key ID** and the **Issuer ID** shown on that page.
3. Use `--api-key /path/AuthKey_<KEYID>.p8 --api-key-id <KEYID> --api-issuer <Issuer ID>`. You can
   also store it as a profile:

       xcrun notarytool store-credentials lfcp-notary --key /path/AuthKey_<KEYID>.p8 \
         --key-id <KEYID> --issuer <Issuer ID>

   and then use `--notary-profile lfcp-notary`.

## A release

    cd helper
    scripts/sign-release.sh --identity "Developer ID Application: <Name> (<TEAMID>)" \
      --notarize --notary-profile lfcp-notary
    cp -R "build/LFCP Reminders Helper.app" ~/Applications/

Then run `lfcp-bridge doctor` (helper found, signature valid, Reminders access). A new helper
version resets `writesVerified`: run the verification again (`lfcp-bridge verify`, see
[running-the-bridge.md](running-the-bridge.md)) before normal bindings write.

TCC keeps Reminders access as long as the designated requirement stays the same: same bundle
identifier, same Team ID. Moving from the dev certificate to Developer ID changes it **once**:
macOS asks for Reminders access again (`lfcp-bridge doctor --request-access`).
