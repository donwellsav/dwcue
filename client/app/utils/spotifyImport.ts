export function canonicalSpotifyMediaReference(sourcePath: string) {
  return {
    mediaFileName: sourcePath.split(/[\\/]/).pop() || 'audio',
    mediaPath: '',
    mediaServerPath: sourcePath,
  };
}
