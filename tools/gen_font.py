"""Generates LaunchkeyMK4Font.js (bitmap fonts for the Launchkey MK4 screen) from X.Org misc-fixed BDF fonts.

The fonts come from the X.Org package font-misc-misc 1.1.3 ("Public domain font. Share and enjoy."):
https://xorg.freedesktop.org/archive/individual/font/font-misc-misc-1.1.3.tar.xz

Usage:
  python gen_font.py <output LaunchkeyMK4Font.js> [<extracted font-misc-misc-1.1.3 folder>]
  (default font folder: tools/font/font-misc-misc-1.1.3)
"""
import base64
import json
import os
import sys

OUT = sys.argv[1]
FONT_DIR = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "font", "font-misc-misc-1.1.3")

FONTS = [  # (JS name, BDF file, description)
    ("kLarge", "10x20.bdf", "10x20 medium"),
    ("kMediumBold", "9x15B.bdf", "9x15 bold"),
    ("kBold", "8x13B.bdf", "8x13 bold"),
    ("kNarrowBold", "7x13B.bdf", "7x13 bold"),
    ("kSmall", "6x13.bdf", "6x13 medium"),
]

WANTED = list(range(0x20, 0x7F)) + list(range(0xA0, 0x100)) + list(range(0x400, 0x460)) + [0x490, 0x491] + [
    0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2018, 0x2019, 0x201A, 0x201C, 0x201D, 0x201E, 0x2020,
    0x2022, 0x2026, 0x2030, 0x2039, 0x203A, 0x20AC, 0x2116, 0x2122, 0x2190, 0x2191, 0x2192, 0x2193, 0x2212,
    0x221E, 0x266D, 0x266F]


def load(name):
    lines = open(os.path.join(FONT_DIR, name), encoding="latin-1").read().splitlines()
    props, glyphs, i = {}, {}, 0
    while i < len(lines):
        parts = lines[i].split()
        if parts and parts[0] in ("FONT_ASCENT", "FONT_DESCENT"):
            props[parts[0]] = int(parts[1])
        if parts and parts[0] == "STARTCHAR":
            enc = dwidth = bbx = None
            rows = []
            i += 1
            while not lines[i].startswith("ENDCHAR"):
                p = lines[i].split()
                if p[0] == "ENCODING":
                    enc = int(p[1])
                elif p[0] == "DWIDTH":
                    dwidth = int(p[1])
                elif p[0] == "BBX":
                    bbx = tuple(int(v) for v in p[1:5])
                elif p[0] == "BITMAP":
                    i += 1
                    while not lines[i].startswith("ENDCHAR"):
                        rows.append(int(lines[i], 16))
                        i += 1
                    break
                i += 1
            if enc is not None and enc >= 0:
                glyphs[enc] = (dwidth, bbx, rows)
        i += 1
    return props["FONT_ASCENT"], props["FONT_DESCENT"], glyphs


def cell_bytes(glyph, width, height, ascent):
    """Glyph rendered into a fixed width x height cell, rows MSB first."""
    dwidth, (bw, bh, bx, by), rows = glyph
    row_bytes = (width + 7) // 8
    cell = [[0] * width for _ in range(height)]
    src_bits = ((bw + 7) // 8) * 8
    top = ascent - by - bh
    for r, bits in enumerate(rows):
        for c in range(bw):
            if bits & (1 << (src_bits - 1 - c)):
                x, y = bx + c, top + r
                if 0 <= x < width and 0 <= y < height:
                    cell[y][x] = 1
    out = bytearray()
    for row in cell:
        for b in range(row_bytes):
            v = 0
            for k in range(8):
                x = b * 8 + k
                if x < width and row[x]:
                    v |= 0x80 >> k
            out.append(v)
    return bytes(out)


def main():
    parts = ['''//************************************************************************************************
//
// Novation Launchkey MK4 - bitmap fonts for screen text the Launchkey font cannot show (Cyrillic)
// Custom control surface integration for Fender Studio Pro
//
// Generated from the X.Org "misc-fixed" fonts (font-misc-misc 1.1.3):
// COPYRIGHT "Public domain font.  Share and enjoy."
// Covered: ASCII, Latin-1, Cyrillic U+0400-U+045F, U+0490/U+0491 and a few symbols.
//
//************************************************************************************************

"use strict";

class LKBitmapFont {
    constructor(width, height, chars, data) {
        this.width = width;
        this.height = height;
        this.rowBytes = (width + 7) >> 3;
        this.glyphBytes = this.rowBytes * height;
        this.chars = chars;
        this.data = data;
        this.bytes = null;
        this.offsets = null;
    }

    prepare() {
        if (this.offsets)
            return;
        this.bytes = LKBitmapFont.decodeBase64(this.data.join(""));
        this.offsets = new Map();
        for (let i = 0; i < this.chars.length; i++)
            this.offsets.set(this.chars.charCodeAt(i), i * this.glyphBytes);
    }

    has(code) {
        this.prepare();
        return this.offsets.has(code);
    }

    measure(text) {
        return text.length * this.width;
    }

    // Draws text with its top left corner at x, y; characters without glyph are skipped.
    draw(bitmap, text, x, y) {
        this.prepare();
        for (let i = 0; i < text.length; i++, x += this.width) {
            let offset = this.offsets.get(text.charCodeAt(i));
            if (offset === undefined)
                continue;
            for (let row = 0; row < this.height; row++) {
                let base = offset + row * this.rowBytes;
                for (let col = 0; col < this.width; col++)
                    if (this.bytes[base + (col >> 3)] & (0x80 >> (col & 7)))
                        bitmap.setPixel(x + col, y + row);
            }
        }
    }

    static decodeBase64(text) {
        const kAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let lookup = new Uint8Array(128);
        for (let i = 0; i < kAlphabet.length; i++)
            lookup[kAlphabet.charCodeAt(i)] = i;
        let clean = text.replace(/[^A-Za-z0-9+\\/]/g, "");
        let out = new Uint8Array(Math.floor(clean.length * 3 / 4));
        let bits = 0, count = 0, pos = 0;
        for (let i = 0; i < clean.length; i++) {
            bits = (bits << 6) | lookup[clean.charCodeAt(i)];
            count += 6;
            if (count >= 8) {
                count -= 8;
                out[pos++] = (bits >> count) & 0xFF;
            }
        }
        return out;
    }
}
''']
    stats = []
    for js_name, file, desc in FONTS:
        ascent, descent, glyphs = load(file)
        width = glyphs[ord("M")][0]
        height = ascent + descent
        chars = [c for c in WANTED if c in glyphs]
        missing = [hex(c) for c in WANTED if c not in glyphs]
        data = b"".join(cell_bytes(glyphs[c], width, height, ascent) for c in chars)
        b64 = base64.b64encode(data).decode("ascii")
        chunks = [b64[i:i + 112] for i in range(0, len(b64), 112)]
        chars_literal = json.dumps("".join(chr(c) for c in chars), ensure_ascii=True)
        parts.append(f"\n// {desc} ({file}), {len(chars)} glyphs\n"
                     f"LKBitmapFont.{js_name} = new LKBitmapFont({width}, {height},\n    {chars_literal},\n    [\n"
                     + ",\n".join(f'        "{c}"' for c in chunks) + "\n    ]);\n")
        stats.append(f"{file}: {width}x{height}, {len(chars)} glyphs, {len(data)} bytes, missing {missing}")
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write("".join(parts))
    print("\n".join(stats))
    print("written", OUT, os.path.getsize(OUT), "bytes")


if __name__ == "__main__":
    main()
