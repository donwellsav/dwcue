// Small pure helpers for a captured picture: naming it, turning it into a
// file, and saying where it is in the show.

const MIME_EXTENSION: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg' };

/** A captured picture as the app hands it over: "data:image/png;base64,...". */
export function dataUrlToFile(dataUrl: string, name: string): File {
  const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new Error('The captured picture could not be read.');
  const binary = atob(match[2]!);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new File([bytes], name, { type: match[1]! });
}

const two = (value: number) => String(value).padStart(2, '0');

/**
 * "Capture - Walk-in music - 2026-11-16 10.42.07.png". The time makes every
 * capture its own file, so an earlier one is still there for Undo.
 */
export function captureFileName(label: string, at: Date, dataUrl: string): string {
  const mime = /^data:(image\/[a-z]+);/.exec(dataUrl)?.[1] ?? 'image/png';
  // Nothing a file system refuses, and not so long that the name is unwieldy.
  const safe = label.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 48).replace(/[. ]+$/, '');
  const stamp = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} `
    + `${two(at.getHours())}.${two(at.getMinutes())}.${two(at.getSeconds())}`;
  return `Capture - ${safe || 'Standby'} - ${stamp}.${MIME_EXTENSION[mime] ?? 'png'}`;
}

/** A path inside the show folder is stored relative, so the show stays portable. */
export function showRelativePath(folder: string | null | undefined, dest: string): string {
  return folder && dest.startsWith(folder)
    ? dest.slice(folder.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
    : dest;
}

/** Where the engine serves a show picture from, for a thumbnail. */
export function showMediaUrl(
  serverUrl: string | null | undefined,
  accessToken: string | null | undefined,
  folder: string | null | undefined,
  path: string | null | undefined,
): string | null {
  if (!path || !serverUrl) return null;
  let absolute = path;
  if (!/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(path)) {
    if (!folder) return null;
    absolute = `${folder.replace(/[\\/]+$/, '')}/${path}`;
  }
  const params = new URLSearchParams({ path: absolute });
  if (accessToken) params.set('access_token', accessToken);
  return `${serverUrl.replace(/\/+$/, '')}/api/media?${params}`;
}
