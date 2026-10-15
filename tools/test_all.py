"""Regression + fuzz tests for the Launchkey MK4 scripts, run in V8 with a mocked Studio Pro host."""
import json
import os
import random
import re
import sys

from py_mini_racer import MiniRacer

PKG = sys.argv[1]
DLL = r"C:\Program Files\Fender\Studio Pro 8\Plugins\musicdevices.dll"


def sdk_sources():
    data = open(DLL, "rb").read()
    found = {}
    for m in re.finditer(rb"[\x09\x0a\x0d\x20-\x7e]{400,}", data):
        seg = data[m.start():m.end()].decode("latin-1")
        for name in ("controlsurfacedevice.ts", "controlsurfacecomponent.ts", "midiprotocol.ts", "musicprotocol.ts"):
            if "Filename    : " + name in seg[:600]:
                found[name] = seg
    assert len(found) == 4, found.keys()
    return found


def script(name):
    src = open(os.path.join(PKG, name), encoding="utf-8").read()
    return re.sub(r'^\s*include_file\(.*?\);\s*$', "", src, flags=re.M)


SDK = sdk_sources()
HOST = r"""
var LOG = [];
var Host = { Interfaces: { IObserver: 1, IParamObserver: 2 }, Console: { writeLine: function (m) { LOG.push(m); } },
  Signals: { advise: function () {}, unadvise: function () {} },
  GUI: { Commands: { interpretCommand: function () {}, deferCommand: function () {} } },
  Attributes: function () { return {}; } };
function hx(v) { return ("0" + v.toString(16).toUpperCase()).slice(-2); }
"""
DEVICE_HOST = r"""
var OUT = [], RAW = [], BITMAPS = [], handlers = {}, list = [], LAST_BITMAP_TIME = -1, PACING_ERRORS = [];
var hostDevice = {
  addHandler: function (n, h) { if (handlers[n]) throw new Error("duplicate handler " + n); handlers[n] = h; list.push(h); return list.length - 1; },
  sendMidiEvent: function (s, a, b) { RAW.push([s, a, b]); OUT.push(hx(s) + " " + hx(a) + " " + hx(b)); },
  sendSysexEvent: function (d, l) { var r = [], t = ""; for (var i = 0; i < l; i++) { r.push(d[i]); t += (d[i] >= 32 && d[i] < 127) ? String.fromCharCode(d[i]) : "."; }
    if (l > 8 && r[6] == 0x09) {
      if (LAST_BITMAP_TIME >= 0 && Date.now() - LAST_BITMAP_TIME < 600) PACING_ERRORS.push("bitmap while previous one unacknowledged");
      LAST_BITMAP_TIME = Date.now(); BITMAPS.push(r);
    }
    RAW.push(r); OUT.push(r.map(hx).join(" ") + "  |" + t); },
  updateValue: function (i, v) { OUT.push("update " + list[i].name + "=" + v); },
  invalidate: function () {}, invalidateAll: function () { OUT.push("invalidateAll"); }, log: function (m) { LOG.push(m); } };
var device = createLaunchkeyMK4DeviceInstance();
device.onInit(hostDevice);
var ACK = [0xF0, 0x00, 0x20, 0x29, 0x02, 0x14, 0x09, 0xF7];
function take() { var o = OUT; OUT = []; RAW = []; return o; }
function send(n, v, f) { if (!handlers[n]) throw new Error("no handler " + n); handlers[n].sendValue(v, f || 0); return take(); }
function midi(s, a, b) { var r = device.onMidiEvent(s, a, b); var o = take(); o.unshift("consumed=" + r); return o; }
function ack() { LAST_BITMAP_TIME = -1; var r = device.onSysexEvent(ACK, ACK.length); var o = take(); o.unshift("ack=" + r); return o; }
"""
FAKE_CLOCK = r"""
var NOW = 1000000;
Date.now = function () { return NOW; };
function idle(ms) { NOW += ms; device.onIdle(0); return take(); }
"""

failures = []


def check(cond, message):
    if not cond:
        failures.append(message)
    print(("  ok   " if cond else "  FAIL ") + message)


def has(out, pattern):
    return any(re.search(pattern, line) for line in out)


def device_context(fake_clock=False):
    ctx = MiniRacer()
    ctx.eval(HOST + SDK["midiprotocol.ts"] + SDK["controlsurfacedevice.ts"]
             + script("LaunchkeyMK4Protocol.js") + script("LaunchkeyMK4Font.js") + script("LaunchkeyMK4Screen.js")
             + script("LaunchkeyMK4MidiDevice.js") + DEVICE_HOST + (FAKE_CLOCK if fake_clock else ""))
    return ctx


def make_js(ctx):
    def js(expr):
        result = ctx.eval("JSON.stringify((function(){ return " + expr + "; })())")
        return json.loads(result) if isinstance(result, str) else None
    return js


def regression():
    print("== regression: device")
    ctx = device_context()
    js = make_js(ctx)
    out = js("(device.onMidiOutConnected(true), take())")
    check(out[0].startswith("F0 00 20 29 02 14 02 7F F7") and out[1] == "9F 0C 7F", "DAW mode on (SysEx + note)")
    check(all(m in out for m in ("B6 54 00", "B6 45 00", "B6 46 00", "B6 47 00")), "feature setup")
    check(has(out, r"^F0 00 20 29 02 14 04 20 61 F7"), "stationary display with auto triggers (0x61)")
    check(has(out, r"^F0 00 20 29 02 14 04 15 62 F7") and has(out, r"^F0 00 20 29 02 14 04 0D 62 F7"), "encoder/fader display config 0x62")
    check(has(out, r"06 24 00 .*\|.*Volume"), "mixer mode name target 0x24")
    check(all(m in out for m in ("B7 1D 00", "B7 1E 00", "B7 1F 00")), "layout queries")

    out = js("send('trackPresent[0]', 1).concat(send('trackColor[0]', 0xFF0000FF), send('trackSelected[0]', 1))")
    check(out[-1] == "B0 25 03", "selected track button white")
    check(js("send('trackSelected[0]', 0)") == ["B0 25 07"], "unselected red track -> dim red 7")
    check(js("LaunchkeyMK4.colorCodeToPaletteIndex(0xFF00FF00)") == 21, "green maps to 21")
    check(js("LaunchkeyMK4.colorCodeToPaletteIndex(0xFFFF0000)") == 45, "blue maps to 45")
    check(js("LaunchkeyMK4.colorCodeToPaletteIndex(0x00000000)") == 3, "transparent color -> white")
    check(js("LaunchkeyMK4.colorCodeToPaletteIndex(0xFF0080FF)") in (9, 84, 96), "orange maps to an orange index")
    for (r, g, b), expected in (((60, 190, 70), 122), ((50, 110, 220), 92), ((230, 90, 170), 56), ((140, 90, 50), 105),
                                ((128, 128, 128), 118), ((30, 50, 120), 104)):
        code = 0xFF000000 | (b << 16) | (g << 8) | r
        check(js(f"LaunchkeyMK4.colorCodeToPaletteIndex({code})") == expected, f"track colour {r},{g},{b} -> {expected}")
    check(js("LaunchkeyMK4.dimPaletteIndex(122)") in (19, 23, 27) and js("LaunchkeyMK4.dimPaletteIndex(96)") in (11, 15),
          "dim shades of extra palette colours keep the hue")

    out = js("send('faderButtonModeState', 1)")
    check("B0 2D 05" in out and has(out, r"Fader Buttons"), "arm mode LED + notification")
    check(js("send('trackArmed[0]', 1)") == ["B0 25 05"], "armed -> red")
    js("send('faderButtonModeState', 0)")

    out = js("send('lpBottomState[0]', 1).concat(send('lpBottomColor[0]', 0xFF00FF00), send('lpBottomAnimation[0]', 1))")
    check(out[-2:] == ["90 70 15", "91 70 00"], "blinking launcher pad")
    out = js("send('lpTopState[3]', 1).concat(send('lpTopColor[3]', 0xFFFF0000), send('lpTopAnimation[3]', 2))")
    check(out[-1] == "92 63 2D", "pulsing launcher pad")

    out = js("send('trackMuted[0]', 1).concat(send('padPageState', 1))")
    check("90 60 29" in out and "90 70 0F" in out and "90 63 00" in out, "mute/solo page colors")

    js("midi(0xB6, 0x48, 0x7F)")
    check(js("device.shiftPressed") is True, "alternative Shift CC 0x48 tracked")
    js("midi(0xB6, 0x48, 0x00)")
    js("midi(0xB6, 0x3F, 0x7F)")
    out = js("midi(0xB0, 0x6D, 0x7F)")
    check(out[0] == "consumed=true" and "update bankLeft=1" in out, "shifted track left 0x6D -> bank left")
    out = js("midi(0xB0, 0x67, 0x7F)")
    check(out == ["consumed=false"], "shift + 0x67 (25/37: Shift + pad up) -> host Previous Track")
    js("midi(0xB6, 0x3F, 0x00)")
    check(js("midi(0xB0, 0x67, 0x7F)") == ["consumed=false"], "track left without shift -> host command")
    out = js("midi(0xB0, 0x6B, 0x7F)")
    check("update bankRight=1" in out, "pad down on mute/solo page -> bank right")
    js("send('padPageState', 0)")

    out = js("midi(0xB6, 0x41, 0x01)")
    check(out[0] == "consumed=true" and "update encoderModeReceiver=1" in out, "alternative encoder mode CC 0x41")
    check(has(out, r"Mixer: Volume"), "stationary shows mixer page")
    out = js("send('encValue[0]', '-6.0')")
    check(has(out, r"06 15 02 .*-6\.0 dB"), "volume formatted")
    out = js("send('mixerPageState', 1)")
    check(has(out, r"06 24 00 .*\|.*Pan") and has(out, r"06 15 01 .*Pan"), "pan page: names + mode name")

    out = js("midi(0xB6, 0x1E, 0x05)")
    check("B0 34 00" in out and js("device.buttonLeds[0x33]") == 1, "transport mode: up LED dim (marker), down off")
    check(has(out, r"04 20 63 F7"), "stationary 8-name arrangement with auto triggers")
    out = js("midi(0xBF, 0x55, 0x41)")
    check(out.count("update encInc[0]=1") == 1, "relative encoder step")
    out = js("midi(0xBF, 0x5C, 0x30)")
    check(out.count("update encDec[7]=1") == 4, "relative steps capped at 4")

    out = js("midi(0xB6, 0x40, 0x01)")
    check("update padModeReceiver=1" in out, "alternative pad mode CC 0x40")
    check(js("send('lpBottomState[1]', 1)") == [], "no pad LEDs outside DAW pad layout")
    out = js("midi(0xB6, 0x1D, 0x02)")
    check(sum(1 for l in out if l[:1] == "9") >= 16, "pads repainted after DAW layout returns")

    out = js("send('fdrTitle[0]', '\u0411\u0430\u0441 \u0433\u0438\u0442\u0430\u0440\u0430')")
    check(has(out, r"\|.*Bas gitara"), "cyrillic transliteration")
    out = js("(device.onExit(), take())")
    check([l.split("  |")[0] for l in out[-2:]] == ["9F 0C 00", "F0 00 20 29 02 14 02 00 F7"], "DAW mode off on exit")
    check(not js("LOG"), "no log output")


def bitmaps(out):
    return sum(1 for line in out if line.startswith("F0 00 20 29 02 14 09 20 "))


def save_previews(frames, path):
    from PIL import Image
    scale, pad = 3, 6
    img = Image.new("RGB", (128 * scale + 2 * pad, len(frames) * (64 * scale + pad) + pad), (25, 25, 25))
    for n, (label, msg) in enumerate(frames):
        top = pad + n * (64 * scale + pad)
        for y in range(64):
            for x in range(128):
                on = msg[8 + y * 19 + x // 7] & (0x40 >> (x % 7))
                color = (235, 245, 255) if on else (45, 45, 50)
                for dy in range(scale - 1):
                    for dx in range(scale - 1):
                        img.putpixel((pad + x * scale + dx, top + y * scale + dy), color)
    img.save(path)


def screen_tests():
    print("== screen pictures")
    ctx = device_context(fake_clock=True)
    js = make_js(ctx)
    previews = []
    out = js("(device.onMidiOutConnected(true), take())")
    check("B7 71 00" in out, "temporary display timeout queried")
    check(bitmaps(out) == 0 and has(out, r"^F0 00 20 29 02 14 04 20 7F F7"), "latin home stays a text display")
    out = js("midi(0xB6, 0x71, 0x28)")
    check(out[0] == "consumed=true" and js("device.screen.popupMs") == 4000, "timeout reply 40 -> 4 s")

    out = js("send('selectedTrackName', '\u0411\u0430\u0441-\u0433\u0438\u0442\u0430\u0440\u0430')")
    check(bitmaps(out) == 1 and not has(out, r"^F0 00 20 29 02 14 04 20 7F"), "cyrillic track name -> picture, text display not brought up")
    check(has(out, r"06 20 00 .*\|.*Bas-gitara"), "transliterated text kept as fallback")
    check(js("BITMAPS[BITMAPS.length - 1].length") == 1225, "bitmap message is 1225 bytes")
    previews.append(("home", js("BITMAPS[BITMAPS.length - 1]")))
    out = js("send('selectedTrackName', '\u0412\u043e\u043a\u0430\u043b')")
    check(bitmaps(out) == 0, "no second picture before the ack")
    out = js("ack()")
    check(out[0] == "ack=true" and bitmaps(out) == 1, "next picture after the ack")
    check(bitmaps(js("ack()")) == 0, "nothing pending after the last ack")

    out = js("send('fdrTitle[0]', '\u0411\u0430\u0441')")
    check(has(out, r"^F0 00 20 29 02 14 04 05 02 F7") and has(out, r"06 05 00 .*\|.*Bas"),
          "fader with cyrillic name: no automatic Launchkey pop-up, texts re-sent")
    out = js("midi(0xBF, 0x05, 0x40)")
    check(bitmaps(out) == 1 and not has(out, r"04 05 7F"), "fader move -> picture pop-up")
    out = js("send('fdrValue[0]', '-6.0')")
    check(bitmaps(out) == 0, "value change waits for the ack")
    out = js("ack()")
    check(bitmaps(out) == 1, "updated pop-up after the ack")
    previews.append(("fader pop-up", js("BITMAPS[BITMAPS.length - 1]")))
    js("ack()")
    check(bitmaps(js("idle(3000)")) == 0, "pop-up stays for the timeout")
    check(bitmaps(js("idle(1100)")) == 1, "home picture back after the pop-up")
    js("ack()")

    js("send('fdrTitle[1]', 'Drums')")
    out = js("midi(0xBF, 0x06, 0x40)")
    check(bitmaps(out) == 0, "latin fader -> Launchkey's own pop-up")
    check(bitmaps(js("idle(4000)")) == 0, "picture waits while the Launchkey pop-up is visible")
    check(bitmaps(js("idle(400)")) == 1, "home picture redrawn after the Launchkey pop-up")
    js("ack()")

    js("midi(0xB6, 0x3F, 0x7F)")
    check(bitmaps(js("idle(1000)")) == 0, "no picture while Shift is held")
    js("midi(0xB6, 0x3F, 0x00)")
    check(bitmaps(js("idle(150)")) == 1, "home picture redrawn after Shift")
    js("ack()")

    out = js("send('fdrTitle[0]', 'Bass')")
    check(has(out, r"^F0 00 20 29 02 14 04 05 62 F7"), "latin name -> automatic Launchkey pop-up again")
    out = js("midi(0xBF, 0x05, 0x41)")
    check(bitmaps(out) == 0, "latin fader move -> no picture")
    js("idle(5000)")
    js("ack()")

    out = js("send('focusDeviceName', '\u0420\u0435\u0432\u0435\u0440\u0431\u0435\u0440\u0430\u0442\u043e\u0440')")
    check(bitmaps(out) == 1, "home picture shows the plugin name")
    js("ack()")
    js("send('pageNumberState', 1)")
    out = js("send('pageNumberState', 2)")
    check(bitmaps(out) == 1 and not has(out, r"04 21 7F"), "plugin page notification as picture")
    previews.append(("notification", js("BITMAPS[BITMAPS.length - 1]")))
    js("ack()")
    out = js("send('padPageState', 1)")
    check(bitmaps(out) == 0 and has(out, r"04 21 7F"), "latin notification stays a Launchkey display")
    js("idle(5000)")
    js("ack()")
    out = js("midi(0xB6, 0x1E, 0x05)")
    check(bitmaps(out) == 0 and has(out, r"^F0 00 20 29 02 14 04 20 7F"), "transport mode -> text display brought up")
    check(not js("PACING_ERRORS"), "never a picture before the previous ack")

    long_name = "\u041e\u0447\u0435\u043d\u044c \u0434\u043b\u0438\u043d\u043d\u043e\u0435 \u043d\u0430\u0437\u0432\u0430\u043d\u0438\u0435 \u0434\u043e\u0440\u043e\u0436\u043a\u0438 \u0441 \u043a\u043b\u0430\u0432\u0438\u0448\u043d\u044b\u043c\u0438"
    js("midi(0xB6, 0x1E, 0x01)")
    js("idle(5000)")
    js("ack()")
    out = js(f"send('selectedTrackName', {json.dumps(long_name)})")
    check(bitmaps(out) == 1, "long name -> picture")
    previews.append(("long name", js("BITMAPS[BITMAPS.length - 1]")))
    js("ack()")

    print("== bank overview")
    js("(midi(0xB6, 0x1E, 0x05), idle(5000), ack(), idle(1000), ack())")
    page2 = ["Kick", "Snare", "\u0411\u0430\u0441-\u0433\u0438\u0442\u0430\u0440\u0430", "Vocals Lead Double", "Keys", "", "FX Return", ""]
    def host_page(offset, count, names):
        for i, name in enumerate(names):
            js(f"send('trackPresent[{i}]', {1 if name else 0})")
            js(f"send('fdrTitle[{i}]', {json.dumps(name)})")
        js(f"send('bankOffsetState', {offset})")
        js(f"send('bankCountState', {count})")
    host_page(0, 14, ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8"])
    js("(idle(5000), ack(), idle(5000), ack())")
    js("midi(0xB6, 0x3F, 0x7F)")
    out = js("midi(0xB0, 0x6C, 0x7F)")
    check("update bankRight=1" in out and bitmaps(out) == 0, "Shift + Track > scrolls, overview waits for the names")
    host_page(8, 14, page2[:5] + ["Pad", "FX Return", ""])
    check(bitmaps(js("idle(100)")) == 0, "no overview before the delay")
    out = js("idle(200)")
    check(bitmaps(out) == 0, "overview waits while the Launchkey's Shift screen is up")
    check(js("device.bankOverviewTitle(0)") == "Channels 9-15", "title without count when count is inconsistent")
    before = js("BITMAPS.length")
    host_page(8, 15, page2[:5] + ["Pad", "FX Return", ""])
    check(js("device.bankOverviewTitle(0)") == "Channels 9-15 / 15", "title with range and count")
    check(bitmaps(js("idle(6000)")) == 0 and js("BITMAPS.length") == before, "nothing sent while Shift is held")
    out = js("midi(0xB6, 0x3F, 0x00)")
    check(bitmaps(out) == 0, "nothing right at Shift release")
    out = js("idle(150)")
    check(bitmaps(out) == 1, "overview sent once after Shift release")
    previews.append(("bank overview", js("BITMAPS[BITMAPS.length - 1]")))
    check(bitmaps(js("ack()")) == 0, "no second picture after the ack")
    check(bitmaps(js("idle(3800)")) == 0, "overview stays for the display timeout after release")
    out = js("idle(400)")
    check(has(out, r"^F0 00 20 29 02 14 04 20 7F F7"), "Launchkey's Transport display back after the overview")
    out = js("midi(0xB0, 0x6D, 0x7F)")
    check("update bankLeft=1" in out, "Shift + Track < scrolls back")
    host_page(0, 15, ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8"])
    out = js("idle(300)")
    check(bitmaps(out) == 1 and js("device.bankOverviewTitle(0)") == "Channels 1-8 / 15", "overview without Shift, page 1")
    js("ack()")
    check(not js("PACING_ERRORS"), "bank overview: never a picture before the previous ack")
    save_previews(previews, os.path.join(os.path.dirname(os.path.abspath(__file__)), "js_previews.png"))

    print("== screen pictures: no acknowledgement")
    ctx = device_context(fake_clock=True)
    js = make_js(ctx)
    js("(device.onMidiOutConnected(true), take())")
    js("send('fdrTitle[0]', '\u0411\u0430\u0441')")
    check(bitmaps(js("send('selectedTrackName', '\u0411\u0430\u0441-\u0433\u0438\u0442\u0430\u0440\u0430')")) == 1, "picture sent")
    check(bitmaps(js("(LAST_BITMAP_TIME = -1, idle(700))")) == 1, "no ack -> sent once more")
    out = js("idle(700)")
    check(bitmaps(out) == 0 and has(out, r"^F0 00 20 29 02 14 04 05 62 F7") and has(out, r"^F0 00 20 29 02 14 04 20 7F"),
          "still no ack -> back to text displays")
    check(has(out, r"06 05 00 .*\|.*Bas") and has(out, r"06 20 00 .*\|.*Bas-gitara"), "texts sent again")
    check(bitmaps(js("midi(0xBF, 0x05, 0x40)")) == 0, "no pictures after the fallback")
    for i, name in enumerate(["Kick", "Snare", "Vocals", "Bass Guitar"]):
        js(f"send('trackPresent[{i}]', 1)")
    js("(send('bankCountState', 12), send('bankOffsetState', 8))")
    js("midi(0xB0, 0x6C, 0x7F)")
    for i, name in enumerate(["Kick", "Snare", "Vocals", "Bass Guitar"]):
        js(f"send('fdrTitle[{i}]', {json.dumps(name)})")
    out = js("idle(300)")
    check(bitmaps(out) == 0 and has(out, r"^F0 00 20 29 02 14 04 21 63 F7") and has(out, r"06 21 00 .*\|.*Channels 9-12/12\.$")
          and has(out, r"06 21 04 .*\|.*Bass\.$") and has(out, r"06 21 03 .*\|.*Voca\.$") and has(out, r"^F0 00 20 29 02 14 04 21 7F F7"),
          "no pictures: overview on the Launchkey's 8 name display, 4 letters per name")
    out = js("send('padPageState', 1)")
    check(has(out, r"^F0 00 20 29 02 14 04 21 61 F7") and has(out, r"06 21 01 .*\|.*Mute / Solo"), "next notification back to 2 lines")

    print("== screen pictures: render fuzz")
    ctx.eval(r"""
      var RERR = [];
      (function () {
        var pool = "AZaz09 -+.:/()[]%#@\u0410\u042f\u0430\u044f\u0401\u0451\u0490\u0491\u0404\u0454\u0406\u0456\u0407\u0457\u040e\u045e\u0400\u045d" +
                   "\u00e9\u00df\u00c5\u2116\u00ab\u00bb\u2026\u2014\u221e\u266d\u266f\u2603\u0000\u0007\t\n\uD83C\uDFB8\uFFFF\u3042";
        var seed = 7;
        function rnd(n) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; }
        var bitmap = new LKScreenBitmap();
        for (var k = 0; k < 3000; k++) {
          var lines = [];
          for (var l = 0; l < 9; l++) {
            var s = "", len = rnd(4) == 0 ? rnd(80) : rnd(16);
            for (var c = 0; c < len; c++) s += pool.charAt(rnd(pool.length));
            lines.push(s);
          }
          try {
            var layout = [LKScreenRenderer.kTitleNameValue, LKScreenRenderer.kNameValue, LKScreenRenderer.kChannelList][rnd(3)];
            LKScreenRenderer.render(bitmap, LKScreen.makeFrame(layout, lines, "x"));
            for (var b = 0; b < bitmap.bytes.length; b++) if (bitmap.bytes[b] > 0x7F) { RERR.push("byte > 7F"); break; }
          } catch (e) { RERR.push(String(e) + " " + JSON.stringify(lines)); }
        }
      })();
    """)
    check(not js("RERR.slice(0, 5)"), "3000 random frames render, all bytes 7-bit")


COMPONENT_HOST = r"""
function makeParam(n) { return { name: n, value: 0, setValue: function (v, notify) { this.value = v; if (notify && COMPONENT) COMPONENT.paramChanged(this); },
  setSignalAlways: function () {}, setFeedbackNeeded: function () {} }; }
var PARAMS = {};
var paramList = { addParam: function (n) { return PARAMS[n] = makeParam(n); }, addInteger: function (a, b, n) { return PARAMS[n] = makeParam(n); },
  addString: function (n) { return PARAMS[n] = makeParam(n); }, addAlias: function (n) { return PARAMS[n] = makeParam(n); } };
var launcher = { mode: null, row: 0, col: 0, setMappingMode: function (m) { this.mode = m; },
  getRowOffset: function () { return this.row; }, setRowOffset: function (v) { this.row = v; },
  getColumnOffset: function () { return this.col; }, setColumnOffset: function (v) { this.col = v; } };
var padComponent = { handlers: [], active: -1, addNullHandler: function () { this.handlers.push(null); },
  addHandlerForRole: function (r) { this.handlers.push(r == "launcherinput" ? launcher : {}); },
  getHandler: function (i) { return this.handlers[i]; }, setActiveHandler: function (i) { this.active = i; } };
var connected = [true, true, true, false, false, false, false, false], scrolled = [], bankStart = 0, bankTotal = 3;
var mixerBank = { getElement: function (i) { return { index: bankStart + i, isConnected: function () { return connected[i]; } }; },
  getBankChildIndex: function (e) { return e.index; }, getBankChildCount: function () { return bankTotal; }, scrollTo: function (p) { scrolled.push(p); } };
var followBank = { getElement: function () { return { index: 13 }; } };
var root = { find: function (n) {
  if (n == "MixerMapping") return { find: function (m) { return m == "MixerBank" ? mixerBank : (m == "MixerFollowBank" ? followBank : null); } };
  if (n == "PadSectionElement") return { component: padComponent }; return null; } };
var COMPONENT = createLaunchkeyMK4ComponentInstance();
COMPONENT.onInit({ paramList: paramList, model: { root: root }, find: function () { return null; } });
function setParam(n, v) { PARAMS[n].value = v; COMPONENT.paramChanged(PARAMS[n]); }
"""


def component_regression():
    print("== regression: component")
    ctx = MiniRacer()
    ctx.eval(HOST + SDK["controlsurfacecomponent.ts"] + SDK["musicprotocol.ts"]
             + script("LaunchkeyMK4Protocol.js") + script("LaunchkeyMK4Component.js") + COMPONENT_HOST)
    js = make_js(ctx)
    check(js("padComponent.active") == 1 and js("launcher.mode") == "cellsonly", "launcher active, cells only")
    js("setParam('padPage', 1)")
    check(js("padComponent.active") == 0, "mute/solo page disables launcher")
    js("setParam('padPage', 0)")
    js("(COMPONENT.onPadDown(1), COMPONENT.onPadDown(1), COMPONENT.onPadUp(0))")
    check(js("launcher.row") == 2, "pad down scrolls lanes")
    js("(PARAMS.shiftModifier.value = 1, COMPONENT.onPadDown(1), PARAMS.shiftModifier.value = 0)")
    check(js("launcher.col") == 1, "shift + pad down scrolls scenes")
    js("(launcher.row = 3, launcher.col = 2, setParam('sceneView', 1), launcher.row = 0, launcher.col = 0, setParam('sceneView', 0))")
    check(js("[launcher.mode, launcher.row, launcher.col]") == ["cellsonly", 3, 2], "scene view restores cell offsets")
    js("(function(){ for (var k = 0; k < 20; k++) COMPONENT.onSendNext(1); })()")
    check(js("PARAMS.sendIndex.value") == 7, "send index clamped to 8 slots")
    js("COMPONENT.onPresenceTimer()")
    check(js("[0,1,2,3].map(function(i){ return PARAMS['trackPresent' + i].value; })") == [1, 1, 1, 0], "track presence")
    check(js("[PARAMS.bankOffset.value, PARAMS.bankCount.value]") == [0, 3], "bank position 0 of 3")
    js("(bankStart = 8, bankTotal = 20, COMPONENT.onConnectChannel(0))")
    check(js("[PARAMS.bankOffset.value, PARAMS.bankCount.value]") == [8, 20], "bank position 8 of 20 after scrolling")
    js("(connected[0] = false, bankTotal = 0, COMPONENT.onConnectChannel(0), connected[0] = true, bankStart = 0)")
    check(js("[PARAMS.bankOffset.value, PARAMS.bankCount.value]") == [0, 0], "empty bank")
    js("COMPONENT.onConnectFollowChannel()")
    check(js("scrolled") == [8], "bank follows selected track")


def fuzz(iterations=30000, seed=1234):
    print(f"== fuzz: {iterations} random events")
    rnd = random.Random(seed)
    ctx = device_context(fake_clock=True)
    js = make_js(ctx)
    js("(device.onMidiOutConnected(true), take())")
    names = js("Object.keys(handlers)")
    strings = ["", "Vocals", "-oo", "0dB", "+12.4", "<C>", "L100", "\u0411\u0430\u0441", "\u2603 \u266d \U0001F3B8 emoji",
               "x" * 300, "\u00e9t\u00e9", "\u0000\u0007", "Track\twith\nbreaks", "\u0412\u043e\u043a\u0430\u043b \u2116 2",
               "\u0401\u043b\u043a\u0430 \u0490 \u0407 \u040e \u0400 \u221e " * 3]
    ctx.eval(r"""
      function checkOut(errs) {
        for (var i = 0; i < RAW.length; i++) {
          var m = RAW[i];
          if (m.length == 3) {
            if (!(m[0] >= 0x80 && m[0] <= 0xEF)) errs.push("bad status " + m);
            if (!(m[1] >= 0 && m[1] <= 127 && m[2] >= 0 && m[2] <= 127) || m.some(isNaN)) errs.push("bad data " + m);
          } else {
            if (m[0] != 0xF0 || m[m.length - 1] != 0xF7) errs.push("bad sysex framing " + m.length);
            if (m.length > 512 && !(m[6] == 0x09 && m[7] == 0x20 && m.length == 1225)) errs.push("long sysex " + m.length);
            for (var k = 1; k < m.length - 1; k++) if (!(m[k] >= 0 && m[k] < 0x80)) { errs.push("bad sysex byte " + m[k]); break; }
            if (m[6] == 0x06) for (var k = 9; k < m.length - 1; k++) if (m[k] < 0x20 || m[k] > 0x7E) { errs.push("non ascii text " + m[k]); break; }
            if (m[6] == 0x06 && m.length - 10 > 16) errs.push("text too long " + (m.length - 10));
          }
        }
        RAW = []; OUT = [];
      }
      var ERRS = [];
    """)
    statuses = [0x90, 0x80, 0xB0, 0xB6, 0xB7, 0xBF, 0xBE, 0x99, 0xA0, 0xE0, 0x9F]
    for i in range(iterations):
        r = rnd.random()
        if r < 0.45:
            status = rnd.choice(statuses) if rnd.random() < 0.8 else rnd.randrange(0x80, 0xF0)
            d1 = rnd.choice([0x1D, 0x1E, 0x1F, 0x3F, 0x40, 0x41, 0x48, 0x55, 0x5C, 0x66, 0x67, 0x6A, 0x6B, 0x6C, 0x6D, 0x33, 0x34,
                             0x05, 0x0C, 0x0D, 0x15, 0x1C, 0x71]) if rnd.random() < 0.6 else rnd.randrange(128)
            d2 = rnd.choice([0, 1, 2, 4, 5, 6, 15, 0x3F, 0x40, 0x41, 0x7F]) if rnd.random() < 0.6 else rnd.randrange(128)
            expr = f"device.onMidiEvent({status}, {d1}, {d2})"
        elif r < 0.95:
            name = rnd.choice(names)
            kind = rnd.random()
            if kind < 0.3:
                value = json.dumps(rnd.choice(strings))
            elif kind < 0.5:
                value = str(rnd.choice([0, 1, 0.5, 2, 7, -1, 127, 0xFF0000FF, 0x00000000, 0xFF123456, 4294967295]))
            elif kind < 0.55:
                value = rnd.choice(["null", "undefined", "NaN"])
            else:
                value = repr(rnd.random())
            flags = rnd.choice([0, 0, 256, 512])
            expr = f"handlers[{json.dumps(name)}].sendValue({value}, {flags})"
        elif r < 0.97:
            expr = "ack()" if rnd.random() < 0.9 else "device.onSysexEvent([0xF0, 0x7E, 0x00, 0x06, 0x02, 0xF7], 6)"
        else:
            expr = f"(device.refreshDueTime = 1, NOW += {rnd.choice([0, 50, 120, 650, 1500, 4500])}, device.onIdle(0))"
        try:
            ctx.eval(f"try {{ {expr}; checkOut(ERRS); }} catch (e) {{ ERRS.push('exception: ' + e + ' in ' + {json.dumps(expr)}); }}")
        except Exception as e:
            failures.append(f"engine error {e}")
            break
        if i % 5000 == 0:
            errs = js("ERRS.length")
            if errs:
                break
    errs = js("ERRS.slice(0, 10)")
    count = js("ERRS.length")
    check(count == 0, f"fuzz invariants hold ({count} violations) {errs}")
    check(not js("PACING_ERRORS"), f"fuzz: pictures paced by acks ({js('BITMAPS.length')} pictures)")


regression()
screen_tests()
component_regression()
fuzz()
print()
print("FAILURES:", len(failures))
for f in failures:
    print(" -", f)
sys.stdout.flush()
os._exit(1 if failures else 0)
