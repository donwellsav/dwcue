// =====================================================================
// plugins/liveplay-server.client.ts
// ---------------------------------------------------------------------
// Nuxt plugin (client-side only) that:
//   1. Reads the server-mode config from Electron's main process
//      (local vs remote, persisted in <userData>/liveplay-server.json).
//   2. Points useLiveplayServer at the correct URL.
//   3. Listens for state changes from the main process (e.g. the user
//      flipped to remote mode in the settings modal) and re-targets.
//   4. Kicks off the auto-reconnecting WebSocket.
// =====================================================================
import { defineNuxtPlugin } from 'nuxt/app';
import { useLiveplayServer } from '~/composables/useLiveplayServer';
import { useShowControl } from '~/composables/useShowControl';
import { useConnectionGuard } from '~/composables/useConnectionGuard';

export default defineNuxtPlugin(async () => {
  const server = useLiveplayServer();

  // Installs the while-disconnected input freeze and the post-reconnect
  // "does the server still have our project?" probe. Wired before the socket
  // opens so the very first reconnect is covered.
  useConnectionGuard();

  // Subscribe to the server-owned operator state (selection / Show Mode /
  // locale) before the socket opens, so the first playback_snapshot is not
  // missed. Wiring it here rather than in a component means it stays live
  // even in windows that never mount the playlist (the detached QuickPlay window).
  useShowControl();

  const ep: any = (globalThis as any).electronAPI?.liveplayServer;

  if (ep) {
    let configRevision = 0;
    const isManagedToken = (value: unknown): value is string =>
      typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

    const applyElectronConfig = async (
      cfg: any,
      status?: any,
      startLocalIfNeeded = false,
    ) => {
      const revision = ++configRevision;
      if (cfg.mode === 'remote') {
        server.configureRemoteConnection(cfg.remoteUrl, String(server.accessToken || ''));
        return;
      }

      const localUrl = `http://127.0.0.1:${cfg.localPort ?? 4480}`;
      const currentToken = status?.running && isManagedToken(status.accessToken)
        ? status.accessToken
        : '';
      if (currentToken) {
        server.configureManagedConnection(localUrl, currentToken);
        return;
      }

      // Never open an unauthenticated socket while Electron is starting or
      // replacing the managed server. State pushes consume a ready token but
      // must not turn an explicit shutdown into an automatic restart.
      server.disconnect();
      if (!startLocalIfNeeded) return;

      const ready = await ep.ensureRunning();
      if (revision !== configRevision) return;
      if (!ready?.ok || !isManagedToken(ready.accessToken)) {
        throw new Error(ready?.error || 'managed server did not provide an access credential');
      }
      server.configureManagedConnection(
        `http://127.0.0.1:${ready.port ?? cfg.localPort ?? 4480}`,
        ready.accessToken,
      );
    };
    try {
      const status = await ep.getStatus();
      const cfg = status?.config ?? await ep.getConfig();
      await applyElectronConfig(cfg, status, true);
    } catch (e) {
      console.warn('[liveplay] failed to configure Electron server:', e);
      server.disconnect();
    }

    // An engine that stopped for good (crashed past its own restart limit,
    // was killed, or could not bind its port) is started again while the
    // operator window's connection stays lost. It comes back without the
    // show; the reconnect check then offers to reopen it. One that is still
    // running but slow is left alone: the socket's own retries find it.
    const isOperatorWindow = (() => {
      const query = new URLSearchParams(window.location.search);
      return query.get('quickPlayWindow') !== '1' && query.get('videoOutput') !== '1';
    })();
    let reviving = false;
    const ENGINE_REVIVE_MS = 5000;
    if (isOperatorWindow) setInterval(async () => {
      if (reviving || !server.connectionLost) return;
      reviving = true;
      try {
        const status = await ep.getStatus();
        const cfg = status?.config ?? await ep.getConfig();
        if (!cfg || cfg.mode === 'remote' || status?.running) return;
        console.warn('[liveplay] the local engine is not running; starting it again');
        await applyElectronConfig(cfg, status, true);
      } catch (e) {
        console.warn('[liveplay] could not start the local engine again:', e);
      } finally {
        reviving = false;
      }
    }, ENGINE_REVIVE_MS);

    // Re-target whenever main process tells us the config changed. Revision
    // fencing prevents a slow local start from overriding a newer remote pick.
    ep.onStateChange?.((payload: any) => {
      const cfg = payload?.config;
      if (!cfg) return;
      void applyElectronConfig(cfg, payload).catch((e) => {
        console.warn('[liveplay] failed to apply Electron server state:', e);
        server.disconnect();
      });
    });
  } else {
    server.connect();
  }

  return {
    provide: { liveplay: server },
  };
});
