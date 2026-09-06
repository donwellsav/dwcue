'use strict';

// CJS shim for Electron main (`require('./test-card-config')`). The canonical
// implementation is ESM in `./test-card-config.mjs` so the Nuxt renderer can
// named-import it in both dev (Vite serve) and production (Rollup bundle).
// Electron 42 / Node 22 `require()` loads ESM that has no top-level await.
module.exports = require('./test-card-config.mjs');
