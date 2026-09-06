'use strict';

function createAppLifecycleActions({
  prepare,
  relaunch,
  exit,
  quit,
  stopServer,
  installUpdate,
  confirmQuit,
}) {
  return {
    relaunch: async () => {
      await prepare();
      relaunch();
      exit(0);
      return true;
    },
    exit: async () => {
      await prepare();
      exit(0);
      return true;
    },
    confirm: async (options) => {
      if (options?.installUpdate === true) {
        return installUpdate({ runAfterInstall: options.runAfterInstall !== false });
      }
      await prepare();
      if (options?.stopServer === true && !(await stopServer())) {
        throw new Error('The managed audio server could not be stopped.');
      }
      confirmQuit();
      quit();
      return true;
    },
  };
}

function createWillQuitHandler({ prepare, exit, recover, onFailure }) {
  let pending = null;
  return (event) => {
    event.preventDefault();
    if (pending) return;
    pending = (async () => {
      await prepare();
      exit();
    })().catch((error) => {
      pending = null;
      try { onFailure(error); } catch { /* recovery must still restore a usable window */ }
      try { recover(); } catch { /* do not turn a vetoed quit into an unhandled rejection */ }
    });
  };
}

module.exports = { createAppLifecycleActions, createWillQuitHandler };
