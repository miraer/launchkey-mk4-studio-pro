"""Renders example Launchkey screens with the script's own renderer (LaunchkeyMK4Screen.js) to PNG files.

The pictures are exactly the 128 x 64 bitmaps the script sends to the keyboard.

Usage:
  python render_screens.py [<package folder>] [<output folder>]

Requires: pip install mini-racer pillow
"""
import json
import os
import re
import sys

from PIL import Image
from py_mini_racer import MiniRacer

HERE = os.path.dirname(os.path.abspath(__file__))
PACKAGE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "Novation Launchkey MK4")
OUTPUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "..", "docs")

SCREENS = [
    ("screen-track.png", "kNameValue", ["\u0411\u0430\u0441-\u0433\u0438\u0442\u0430\u0440\u0430", "Mixer: Volume"]),
    ("screen-fader.png", "kTitleNameValue", ["\u0412\u043e\u043a\u0430\u043b", "Volume", "-6.0 dB"]),
    ("screen-channels.png", "kChannelList", ["Channels 9-16 / 20", "Kick", "Snare", "\u0411\u0430\u0441",
                                             "\u0412\u043e\u043a\u0430\u043b", "Keys", "Pad", "Strings", "FX Return"]),
]


def load(name):
    source = open(os.path.join(PACKAGE, name), encoding="utf-8").read()
    return re.sub(r'^\s*include_file\(.*?\);\s*$', "", source, flags=re.M)


def to_png(data, path, scale=3):
    background, lit, unlit = (14, 16, 20), (232, 242, 255), (34, 38, 46)
    pad = 2 * scale
    img = Image.new("RGB", (128 * scale + 2 * pad, 64 * scale + 2 * pad), background)
    px = img.load()
    for y in range(64):
        for x in range(128):
            on = data[y * 19 + x // 7] & (0x40 >> (x % 7))
            for dy in range(scale - 1):
                for dx in range(scale - 1):
                    px[pad + x * scale + dx, pad + y * scale + dy] = lit if on else unlit
    img.save(path)


def main():
    ctx = MiniRacer()
    ctx.eval(load("LaunchkeyMK4Protocol.js") + load("LaunchkeyMK4Font.js") + load("LaunchkeyMK4Screen.js"))
    os.makedirs(OUTPUT, exist_ok=True)
    for file, layout, lines in SCREENS:
        data = json.loads(ctx.eval(
            f"(function () {{ var bitmap = new LKScreenBitmap();"
            f" LKScreenRenderer.render(bitmap, LKScreen.makeFrame(LKScreenRenderer.{layout}, {json.dumps(lines)}, 'doc'));"
            f" return JSON.stringify(Array.from(bitmap.bytes)); }})()"))
        path = os.path.join(OUTPUT, file)
        to_png(data, path)
        print("written", os.path.normpath(path))


if __name__ == "__main__":
    main()
