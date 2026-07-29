// =====================================================================
// useConnectionGuard.ts
// ---------------------------------------------------------------------
// Everything that has to happen while the server is unreachable.
//
// The server owns the project document, the selection, Show Mode and every
// transport decision. When the socket is down, a click that mutates any of
// those either drops silently (wsSend logs "WS send DROPPED") or throws in a
// fetch — and the operator finds out at the worst possible moment, mid-show.
// So while the connection is lost we:
//
//   * freeze input      — a capture-phase keydown trap plus the modal's own
//                         full-screen overlay for pointer events, so no UI
//                         state can drift away from the server's copy
//   * say so, loudly    — ConnectionLostModal + the animated header pill
//   * keep retrying     — useLiveplayServer's backoff loop never stops
//
// And on the way back up, one more check: a *restarted* server accepts the
// WebSocket happily but has forgotten the project. That looks identical to a
// healthy reconnect from the socket's point of view, so we ask the server what
// it's holding and, if the answer is "nothing", hand the operator the choice
// between reopening their project and starting fresh (SessionRecoveryModal).
//
// Wired once per renderer from plugins/liveplay-server.client.ts.
// =====================================================================

// Renderer-scoped: the plugin calls this once, but guard anyway so a component
// calling it for the recovery actions can't install a second keyboard trap.
let _wired = false;

export const useConnectionGuard = () => {
  const server = useLiveplayServer();

  // Set when we reconnect to a server that no longer has our project loaded.
  const sessionLost = useState<boolean>('connectionGuard.sessionLost', () => false);
  // Guards against a second recovery prompt stacking on the first while the
  // operator is still deciding.
  const recovering = useState<boolean>('connectionGuard.recovering', () => false);

  // Put the project back on the server so the operator picks up where they
  // left off. useProject owns the sequencing — load the file to re-establish
  // the server's directory context, then overlay any unsaved edits — because
  // getting that order wrong is what leaves a resumed session without
  // waveforms. See resumeProjectOnServer.
  const resumeSession = async (): Promise<boolean> => {
    const { resumeProjectOnServer } = useProject();
    recovering.value = true;
    try {
      const ok = await resumeProjectOnServer();
      if (ok) sessionLost.value = false;
      return ok;
    } catch (e) {
      console.error('[connectionGuard] resume failed:', e);
      return false;
    } finally {
      recovering.value = false;
    }
  };

  // Drop the local project and land back on the welcome screen. The server is
  // already empty, so this only has to clear the client.
  const startFresh = async (): Promise<void> => {
    const { closeProject } = useProject();
    recovering.value = true;
    try {
      await closeProject();
      sessionLost.value = false;
    } finally {
      recovering.value = false;
    }
  };

  if (_wired || !import.meta.client) {
    return { sessionLost, recovering, resumeSession, startFresh };
  }
  _wired = true;

  // ---- Input freeze --------------------------------------------------
  // Capture phase on `window` runs before every other listener in the app
  // (MainWorkspace, useCartHotkeys and the playback keys all listen in the
  // bubble phase), so one trap here covers all of them without each handler
  // needing its own check. Keys inside the dialogs themselves are exempt, so
  // the operator can always drive the recovery UI.
  const trapKeydown = (e: KeyboardEvent) => {
    if (!server.connectionLost) return;
    // Keys aimed at the recovery dialogs — or at Server Settings, which stacks
    // above them so the URL can be retargeted — go through untouched.
    const el = e.target as HTMLElement | null;
    if (el?.closest?.('.clm-overlay, .srm-overlay, .modal-backdrop')) return;
    // Tab still moves focus, so the dialog is reachable from anywhere.
    if (e.key === 'Tab') return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  window.addEventListener('keydown', trapKeydown, true);

  // ---- Session recovery ----------------------------------------------
  // Ask the server what it is holding now that we're back. `hasOpenProject`
  // false while the client still shows a project means the server process was
  // replaced under us.
  //
  // The callback fires from a WebSocket event, outside any Nuxt context, so
  // useState/useProject would throw there — runWithContext restores it.
  const nuxtApp = useNuxtApp();
  server.onReconnected(() => {
    void nuxtApp.runWithContext(async () => {
      const { currentProject } = useProject();
      if (!currentProject.value || sessionLost.value || recovering.value) return;
      try {
        const header = await server.fetchProjectHeader();
        if (!header?.hasOpenProject) sessionLost.value = true;
      } catch (e) {
        // Couldn't ask — don't throw an unnecessary dialog at the operator on
        // the strength of a failed probe. The next reconnect re-checks.
        console.warn('[connectionGuard] post-reconnect project probe failed:', e);
      }
    });
  });

  return { sessionLost, recovering, resumeSession, startFresh };
};
