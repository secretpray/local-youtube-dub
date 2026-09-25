#!/bin/sh
# Renders the extension icons from extension/icons/lion.svg: the black lion on
# an amber rounded tile, so it reads on both light and dark browser toolbars.
set -eu
cd "$(dirname -- "$0")/../extension/icons"
command -v rsvg-convert >/dev/null || { echo "Нужен rsvg-convert (brew install librsvg)" >&2; exit 2; }
python3 - <<'PY'
import re
lion = open("lion.svg").read()
side = float(re.search(r'viewBox="0 0 ([\d.]+)', lion).group(1))
inner = lion[lion.index("<g "):lion.rindex("</svg>")]
pad = side * 0.08
tile = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {side + 2 * pad:.0f} {side + 2 * pad:.0f}">
<defs><linearGradient id="amber" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#FBBF24"/><stop offset="1" stop-color="#D97706"/></linearGradient></defs>
<rect width="100%" height="100%" rx="{side * 0.22:.0f}" fill="url(#amber)"/>
<g transform="translate({pad:.0f} {pad:.0f})">{inner}</g>
</svg>
'''
open("lion-tile.svg", "w").write(tile)
PY
for size in 16 32 48 128; do
  rsvg-convert -w "$size" -h "$size" lion-tile.svg -o "lion-$size.png"
done
echo "Иконки обновлены"
