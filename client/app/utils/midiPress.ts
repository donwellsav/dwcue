/** A CC or pitch bend mapped to a button fires once as it rises past its
 *  midpoint, and again only after it has come back down: a fader or a
 *  pitch-bend wheel mapped to GO must not fire on every message it sends. */
export const controlPressed = (held: Map<string, boolean>, key: string, value: number): boolean => {
  const isHeld = value > 63;
  const wasHeld = held.get(key) === true;
  held.set(key, isHeld);
  return isHeld && !wasHeld;
};
