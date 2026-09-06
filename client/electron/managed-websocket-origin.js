// Keep existing managed servers usable without restarting a live audio engine.
// Chromium uses file:// for packaged WebSockets; older Cue servers accept null.
function managedWebSocketHeaders(details, identity, trustedRenderer) {
  const headers = details.requestHeaders;
  if (!trustedRenderer || details.resourceType !== 'webSocket' || !identity || identity.legacy ||
      !/^[0-9a-f]{64}$/.test(identity.accessToken || '')) return headers;

  let url;
  try { url = new URL(details.url); } catch { return headers; }
  const tokens = url.searchParams.getAll('access_token');
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' ||
      Number(url.port) !== identity.port || url.pathname !== '/ws' ||
      url.username || url.password || tokens.length !== 1 || tokens[0] !== identity.accessToken) {
    return headers;
  }
  const originKey = Object.keys(headers).find(key => key.toLowerCase() === 'origin');
  if (!originKey || headers[originKey] !== 'file://') return headers;
  return { ...headers, [originKey]: 'null' };
}

module.exports = { managedWebSocketHeaders };
