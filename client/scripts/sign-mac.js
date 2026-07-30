const path = require('node:path');

const serverRelPath = path.join('Contents', 'Resources', 'server-bin', 'dwcue-server');
const serverEntitlementsPath = path.join(__dirname, '../build/entitlements.server.mac.plist');

async function signMacBuild(signOptions) {
  const originalOptionsForFile = signOptions.optionsForFile;
  if (originalOptionsForFile == null) {
    throw new Error('electron-builder did not provide per-file sign options');
  }

  const appPath = path.resolve(signOptions.app);
  const serverPath = path.resolve(appPath, serverRelPath);

  signOptions.optionsForFile = (filePath) => {
    const normalizedFile = path.resolve(filePath);
    const options = originalOptionsForFile(normalizedFile);
    if (normalizedFile === serverPath) {
      return {
        ...options,
        entitlements: serverEntitlementsPath,
      };
    }
    return options;
  };

  const { signAsync } = await import('@electron/osx-sign');
  return signAsync(signOptions);
}

exports.default = signMacBuild;
module.exports = signMacBuild;
