'use strict';

const fs = require('node:fs/promises');

// Owns one transient cue on the already selected Cue server. This is resource
// lifetime management only; decoding, looping, routing and timing stay native.
class TestCardPlayback {
  constructor({ assetPath, onChange, request = fetch }) {
    this.assetPath = assetPath;
    this.onChange = onChange;
    this.request = request;
    this.session = null;
    this.error = null;
    this.desired = null;
    this.generation = 0;
    this.work = Promise.resolve();
  }

  get playback() {
    if (!this.session) return null;
    const { cue, description } = this.session;
    return { cueId: cue.id, path: cue.file_path, duration: cue.duration_sec, description };
  }

  async call(connection, route, { method = 'POST', body, allowMissing = false } = {}) {
    const headers = { Authorization: `Bearer ${connection.accessToken}` };
    if (body !== undefined && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const response = await this.request(`${connection.serverUrl}${route}`, {
      method, headers, body, redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.json()).error || ''; } catch { /* non-JSON server error */ }
      throw new Error(detail || `Native AV Sync request failed (${response.status}).`);
    }
    return response.json();
  }

  async release(replacementConnection = null) {
    const session = this.session;
    if (!session) return;
    // DELETE stops and unloads this cue, without touching Program cues. Keep
    // ownership on failure: another selection must not start a second tone.
    const route = '/api/cues/' + encodeURIComponent(session.cue.id);
    const options = { method: 'DELETE', allowMissing: true };
    try {
      await this.call(session.connection, route, options);
    } catch (error) {
      if (!replacementConnection || replacementConnection.serverUrl !== session.connection.serverUrl
        || replacementConnection.accessToken === session.connection.accessToken) throw error;
      // A restarted server has a new credential and no old cue. Ask that same
      // endpoint with its current credential; never send credentials elsewhere.
      await this.call(replacementConnection, route, options);
    }
    this.session = null;
    this.onChange();
  }

  update(desired, cleanupConnection = desired?.connection ?? null) {
    const previous = this.desired;
    const unchanged = (!desired && !previous) || (desired && previous
      && desired.rate === previous.rate && desired.deviceId === previous.deviceId
      && desired.connection.serverUrl === previous.connection.serverUrl
      && desired.connection.accessToken === previous.connection.accessToken
      && desired.connection.local === previous.connection.local);
    const connectionChanged = cleanupConnection?.serverUrl !== this.cleanupConnection?.serverUrl
      || cleanupConnection?.accessToken !== this.cleanupConnection?.accessToken;
    if (unchanged && !connectionChanged && !this.error) return this.work;
    this.cleanupConnection = cleanupConnection;
    this.desired = desired;
    const generation = ++this.generation;
    this.work = this.work.then(async () => {
      if (generation !== this.generation) return;
      await this.release(cleanupConnection);
      if (generation !== this.generation) return;
      this.error = null;
      this.onChange();
      if (!desired) return;

      const { connection, rate, deviceId } = desired;
      const filePath = this.assetPath(rate);
      let body;
      if (connection.local) {
        body = { file_path: filePath, output_device_id: deviceId };
      } else {
        // Remote diagnostics use the existing remote engine. Stage only this
        // bundled, public asset; the server owns and removes its temporary file.
        const bytes = await fs.readFile(filePath);
        body = new FormData();
        body.set('output_device_id', deviceId);
        body.set('file', new Blob([bytes], { type: 'video/webm' }), `${rate}.webm`);
      }
      const cue = await this.call(connection, '/api/diagnostics/av-sync', { body });
      if (!cue || typeof cue.id !== 'string' || typeof cue.file_path !== 'string') {
        throw new Error('Native AV Sync returned an invalid cue.');
      }
      this.session = {
        cue, connection, rate, deviceId,
        description: deviceId === 'default' ? 'Program output' : deviceId,
      };
      if (generation !== this.generation) {
        await this.release();
        return;
      }
      if (!cue.file_loaded || !Number.isFinite(cue.duration_sec) || cue.duration_sec <= 0) {
        await this.release();
        throw new Error(cue.decode_error || 'Native AV Sync media could not be decoded.');
      }
      this.onChange();
      try {
        await this.call(connection, `/api/cues/${encodeURIComponent(cue.id)}/play`);
      } catch (error) {
        await this.release();
        throw error;
      }
    }).catch((error) => {
      this.error = error instanceof Error ? error.message : String(error);
      this.onChange();
    });
    return this.work;
  }

  async fail(message, cleanupConnection) {
    const work = this.update(null, cleanupConnection);
    const generation = this.generation;
    await work;
    if (generation !== this.generation) return;
    this.error ??= message;
    this.onChange();
  }
}

module.exports = { TestCardPlayback };
