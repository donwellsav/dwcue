#!/usr/bin/env python3
"""Cut the Material Symbols Rounded icon font down to the icons the app uses.

The full font holds about 3,800 icons and weighs 5 MB; the app uses about a
hundred. This writes a small font with only those, and a list of their names.

    python3 scripts/subset-icon-font.py          # needs fonttools and brotli

Run it again after adding an icon the app has not used before. The client
checks fail when the source names an icon that the small font does not hold
(see check-live-safety.js), so a missing icon cannot ship.

An icon counts as used when its name appears as a whole word anywhere in the
client source, so the list errs on the side of keeping an icon.
"""
import json, pathlib, re, sys

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
FULL = ROOT / 'node_modules' / 'material-symbols' / 'material-symbols-rounded.woff2'
OUT_DIR = ROOT / 'client' / 'assets' / 'fonts' / 'material-symbols'
OUT = OUT_DIR / 'material-symbols-rounded-subset.woff2'
NAMES = OUT_DIR / 'icons.json'            # the icons in the small font
ALL_NAMES = ROOT / 'scripts' / 'material-symbols-rounded-names.json'   # every icon in the full font
SOURCE_DIRS = [ROOT / 'client' / 'app', ROOT / 'client' / 'electron']
SOURCE_SUFFIXES = {'.vue', '.ts', '.js', '.mjs', '.cjs', '.scss'}
LETTERS = 'abcdefghijklmnopqrstuvwxyz0123456789_'


def icon_glyphs(font):
    """Icon name -> glyph, read from the font's ligatures (typing the name draws the icon)."""
    by_glyph = {glyph: chr(code) for code, glyph in font.getBestCmap().items()}
    icons = {}
    for lookup in font['GSUB'].table.LookupList.Lookup:
        for table in lookup.SubTable:
            if table.LookupType == 7:
                table = table.ExtSubTable
            if table.LookupType != 4:
                continue
            for first, ligatures in table.ligatures.items():
                for ligature in ligatures:
                    name = ''.join(by_glyph.get(glyph, '?') for glyph in [first, *ligature.Component])
                    if re.fullmatch(r'[a-z0-9_]+', name):
                        icons[name] = ligature.LigGlyph
    return icons


def names_in_source(all_names):
    text = '\n'.join(
        path.read_text(errors='ignore')
        for base in SOURCE_DIRS for path in base.rglob('*')
        if path.is_file() and path.suffix in SOURCE_SUFFIXES)
    words = set(re.findall(r'[a-z0-9_]+', text))
    return sorted(name for name in all_names if name in words)


def main():
    font = TTFont(FULL)
    icons = icon_glyphs(font)
    used = names_in_source(icons)
    options = subset.Options()
    options.flavor = 'woff2'
    options.layout_features = ['*']
    options.layout_closure = False        # keep only the ligatures of the icons asked for
    options.notdef_outline = True
    options.name_IDs = ['*']
    subsetter = subset.Subsetter(options)
    subsetter.populate(glyphs=[icons[name] for name in used], unicodes=[ord(c) for c in LETTERS])
    subsetter.subset(font)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    font.save(OUT)

    kept = icon_glyphs(TTFont(OUT))
    missing = [name for name in used if name not in kept]
    if missing:
        sys.exit(f'the small font lost {len(missing)} icons: {missing[:8]}')
    NAMES.write_text(json.dumps(sorted(kept), indent=0) + '\n')
    ALL_NAMES.write_text(json.dumps(sorted(icons), separators=(',', ':')) + '\n')
    print(f'{len(icons)} icons in the full font ({FULL.stat().st_size / 1e6:.2f} MB); '
          f'kept {len(kept)} ({OUT.stat().st_size / 1e3:.0f} KB)')


if __name__ == '__main__':
    main()
