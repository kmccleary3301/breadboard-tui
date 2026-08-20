# A-B2 signing and notarization runbook

Execution is deferred; these commands are the release operator procedure for the
unsigned local `bb` artifact. Run on a macOS host with the Developer ID
Application certificate and notarization credentials installed.

## Requirements

- Apple Developer Program team membership and a `Developer ID Application:
  <Team Name> (<TEAM_ID>)` certificate in the login keychain.
- An App Store Connect API key (`.p8`) with a key ID and issuer/team ID, or an
  authenticated `notarytool` keychain profile.
- A single-file arm64 binary produced by the A-B1 compile step.
- `codesign`, `spctl`, `xcrun`, and `shasum` from the same macOS release family
  used for distribution.

## Commands

```bash
set -euo pipefail
cd /path/to/breadboard
export BB=packages/coding-agent/dist/bb
export IDENTITY='Developer ID Application: BreadBoard Inc. (TEAMID1234)'
export KEYCHAIN_PROFILE='breadboard-notary'

# Confirm the identity and inspect the unsigned artifact.
security find-identity -v -p codesigning
file "$BB"
shasum -a 256 "$BB"

# Sign the one-file executable with a hardened runtime and no timestamp in a
# local dry run. Use --timestamp for the release signature.
codesign --force --options runtime --timestamp --sign "$IDENTITY" "$BB"
codesign --verify --strict --verbose=4 "$BB"
spctl --assess --type execute --verbose=4 "$BB"

# Store an App Store Connect API key in the keychain (one-time setup).
xcrun notarytool store-credentials "$KEYCHAIN_PROFILE" \
  --key /secure/path/AuthKey_KEYID.p8 \
  --key-id KEYID \
  --issuer ISSUER_UUID

# Submit and wait for Apple's result. The request ID and output are release
# evidence and must be retained.
xcrun notarytool submit "$BB" \
  --keychain-profile "$KEYCHAIN_PROFILE" \
  --wait \
  --output-format json | tee /tmp/bb-notary-result.json

# Stapling is normally for bundles/disk images; verify the single-file result
# with Gatekeeper after notarization. Re-run the exact smoke commands.
spctl --assess --type execute --verbose=4 "$BB"
"$BB" --version
"$BB" --help >/tmp/bb-help.txt
"$BB" --smoke-test
shasum -a 256 "$BB" | tee packages/coding-agent/dist/bb.sha256
```

If the release is distributed in a `.dmg` or `.zip`, sign/notarize that outer
container too and run `xcrun stapler staple`/`xcrun stapler validate` on the
container where applicable. Never commit signing keys, API keys, or notarization
profiles.
