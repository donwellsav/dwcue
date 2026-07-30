const fs = require('fs');
const path = require('path');

function canonicalPath(input, allowMissing = false) {
  const absolute = path.resolve(input);
  try {
    return fs.realpathSync.native(absolute);
  } catch (error) {
    if (!allowMissing || error.code !== 'ENOENT') throw error;
  }

  const missing = [];
  let existing = absolute;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error(`No existing ancestor for ${input}`);
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync.native(existing), ...missing);
}

function comparisonPath(input) {
  const normalized = path.normalize(input);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isInside(candidate, root) {
  const relative = path.relative(comparisonPath(root), comparisonPath(candidate));
  return relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

class PathCapabilityRegistry {
  constructor() {
    this.files = new Set();
    this.roots = new Set();
  }

  authorizeFile(filePath, { allowMissing = false } = {}) {
    const canonical = canonicalPath(filePath, allowMissing);
    this.files.add(comparisonPath(canonical));
    return canonical;
  }

  authorizeRoot(rootPath) {
    const canonical = canonicalPath(rootPath);
    if (!fs.statSync(canonical).isDirectory()) throw new Error('Authorized root is not a directory');
    this.roots.add(canonical);
    return canonical;
  }

  authorizeProjectFile(filePath) {
    const canonical = this.authorizeFile(filePath);
    this.authorizeRoot(path.dirname(canonical));
    return canonical;
  }

  allows(candidatePath, { allowMissing = false } = {}) {
    let canonical;
    try {
      canonical = canonicalPath(candidatePath, allowMissing);
    } catch {
      return false;
    }
    const key = comparisonPath(canonical);
    if (this.files.has(key)) return true;
    for (const root of this.roots) {
      if (isInside(canonical, root)) return true;
    }
    return false;
  }

  require(candidatePath, { allowMissing = false, label = 'path' } = {}) {
    const canonical = canonicalPath(candidatePath, allowMissing);
    if (!this.allows(canonical, { allowMissing })) {
      throw new Error(`${label} is outside the user-authorized files and folders`);
    }
    return canonical;
  }
}

module.exports = { PathCapabilityRegistry, canonicalPath, isInside };
