// The text colour that reads on a solid block of `color`: near-black on a
// light colour, white on a dark one. `color` is a #rgb or #rrggbb hex value,
// as cue and QuickPlay colours are stored; anything else gets white.
export const DARK_INK = '#101014';
export const LIGHT_INK = '#ffffff';

export function readableOn(color: string | null | undefined): string {
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((color ?? '').trim())?.[1];
  if (!hex) return LIGHT_INK;
  const full = hex.length === 3 ? [...hex].map(c => c + c).join('') : hex;
  const channel = (index: number) => {
    const value = parseInt(full.slice(index * 2, index * 2 + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  // The contrast with white is (1.05) / (L + 0.05); with near-black about
  // (L + 0.05) / 0.055. They are equal near L = 0.19: above it dark reads better.
  return luminance > 0.19 ? DARK_INK : LIGHT_INK;
}
