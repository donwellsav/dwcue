// electron-builder configuration wrapper.
//
// The static build configuration lives in package.json ("build"). This file
// spreads it and flips exactly two macOS fields based on whether CI provided
// signing credentials (the build-release workflow sets MAC_SIGNING=true when
// the MAC_CSC_LINK / MAC_CSC_KEY_PASSWORD secrets exist):
//
//   unsigned (default, local dev):  identity "-" (ad-hoc), notarize false
//   signed   (release CI):          identity null (Developer ID from the
//                                   CSC_LINK keychain), notarize true
//
// Notarization credentials are read by electron-builder from the environment:
// APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID.
// See SIGNING.md.

const pkg = require('./package.json');

const signingEnabled = process.env.MAC_SIGNING === 'true';

// NB: electron-builder treats `identity: null` as "explicitly skip signing" —
// when signing is enabled the key must be ABSENT (undefined), not null.
const mac = {
  ...pkg.build.mac,
  notarize: signingEnabled,
};
if (signingEnabled) {
  delete mac.identity;
} else {
  mac.identity = '-';
}

module.exports = {
  ...pkg.build,
  mac,
};
