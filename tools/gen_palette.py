"""Samples the Launchkey MK4 colour palette from Novation's Programmer's Reference Guide.

The guide (v3.0, page 15) shows the 128 palette colours as a table image: indices 0-63 in the
left 8 x 8 block, 64-127 in the right one. Each cell's colour is the median of its pixels without
the black index digits. Index 0 means "LED off" and is written as black.

The table draws every colour over a grey base (0x61 in each channel) and shows the dimmer shades
with perceptual brightness steps (FF, DD, B3). For matching DAW colours to LED colours the tool
removes the base and applies gamma 2.2, which approximates the much lower intensity of the dim
shades on the hardware.

Usage:
  python gen_palette.py <Launchkey MK4 Programmer's Reference Guide.pdf> [--write <LaunchkeyMK4Protocol.js>]

Requires: pip install pypdfium2 pillow
"""
import re
import statistics
import sys

import pypdfium2 as pdfium

PAGE = 15           # 1-based page with the "Colour palette" table
BACKGROUND = 40     # pixels with all channels below this are background or digits
CHART_BASE = 0x61   # grey base of the table colours
GAMMA = 2.2


def palette_image(pdf_path):
    page = pdfium.PdfDocument(pdf_path)[PAGE - 1]
    images = [obj for obj in page.get_objects() if obj.type == pdfium.raw.FPDF_PAGEOBJ_IMAGE]
    if not images:
        raise SystemExit(f"no image on page {PAGE}, is this the Launchkey MK4 Programmer's Reference Guide?")
    return images[0].get_bitmap(render=False).to_pil().convert("RGB")


def runs(profile, min_length):
    """Start/end of consecutive True values that are at least min_length long."""
    result, start = [], None
    for i, value in enumerate(profile + [False]):
        if value and start is None:
            start = i
        elif not value and start is not None:
            if i - start >= min_length:
                result.append((start, i))
            start = None
    return result


def sample(img):
    width, height = img.size
    px = img.load()

    def lit(x, y):
        return max(px[x, y]) >= BACKGROUND

    columns = runs([sum(lit(x, y) for y in range(height)) > height // 4 for x in range(width)], 10)
    rows = runs([sum(lit(x, y) for x in range(width)) > width // 4 for y in range(height)], 10)
    if len(columns) != 16 or len(rows) != 8:
        raise SystemExit(f"unexpected table layout: {len(columns)} columns, {len(rows)} rows")
    palette = [0] * 128
    for block in range(2):
        for r, (y0, y1) in enumerate(rows):
            for c, (x0, x1) in enumerate(columns[block * 8:block * 8 + 8]):
                pixels = [px[x, y] for y in range(y0 + 3, y1 - 3) for x in range(x0 + 3, x1 - 3) if lit(x, y)]
                rgb = [int(statistics.median(p[k] for p in pixels)) for k in range(3)]
                palette[block * 64 + r * 8 + c] = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2]
    palette[0] = 0x000000
    return palette


def to_led(colour):
    result = 0
    for shift in (16, 8, 0):
        x = max(0.0, (((colour >> shift) & 0xFF) - CHART_BASE) / (0xFF - CHART_BASE))
        result |= min(255, round(255 * x ** GAMMA)) << shift
    return result


def to_js(palette):
    lines = []
    for i in range(0, 128, 8):
        lines.append("    " + ", ".join(f"0x{v:06X}" for v in palette[i:i + 8]))
    return "LaunchkeyMK4.kPalette = [\n" + ",\n".join(lines) + "\n];"


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    js = to_js([to_led(c) for c in sample(palette_image(sys.argv[1]))])
    if len(sys.argv) >= 4 and sys.argv[2] == "--write":
        path = sys.argv[3]
        source = open(path, encoding="utf-8").read()
        updated, count = re.subn(r"LaunchkeyMK4\.kPalette = \[.*?\];", lambda m: js, source, flags=re.S)
        if count != 1:
            raise SystemExit("kPalette table not found in " + path)
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(updated)
        print("updated", path)
    else:
        print(js)


if __name__ == "__main__":
    main()
