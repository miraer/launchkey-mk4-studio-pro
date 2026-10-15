//************************************************************************************************
//
// Novation Launchkey MK4 (25/37/49/61) - DAW mode protocol
// Custom control surface integration for Fender Studio Pro
//
// Sources: Novation Launchkey MK4 Programmer's Reference Guide v3.0,
//          cross-checked against the open source Bitwig and Zynthian MK4 implementations.
//
//************************************************************************************************

"use strict";

class LaunchkeyMK4 {
    static padNote(padIndex) {
        // Pad index order follows the Studio Pro pad section convention: row 0 = bottom row.
        return padIndex < LaunchkeyMK4.kPadsPerRow
            ? LaunchkeyMK4.kPadBottomRowNote + padIndex
            : LaunchkeyMK4.kPadTopRowNote + (padIndex - LaunchkeyMK4.kPadsPerRow);
    }

    static colorCodeToRgb(colorCode) {
        let code = Number(colorCode) >>> 0;
        let alpha = (code >>> 24) & 0xFF;
        if (alpha == 0)
            return null;
        return { r: code & 0xFF, g: (code >>> 8) & 0xFF, b: (code >>> 16) & 0xFF };
    }

    static paletteRgb(index) {
        let c = LaunchkeyMK4.kPalette[index] || 0;
        return { r: (c >> 16) & 0xFF, g: (c >> 8) & 0xFF, b: c & 0xFF };
    }

    static nearestPaletteIndex(rgb) {
        if (!rgb)
            return LaunchkeyMK4.kColorWhite;
        let key = (rgb.r << 16) | (rgb.g << 8) | rgb.b;
        let cached = LaunchkeyMK4.colorCache.get(key);
        if (cached !== undefined)
            return cached;
        let target = LaunchkeyMK4.rgbToHsv(rgb);
        let bestIndex = LaunchkeyMK4.kColorWhite;
        let bestDistance = Number.MAX_VALUE;
        // Index 0 is "off" and must never be chosen for an existing color.
        for (let i = 1; i < LaunchkeyMK4.kPalette.length; i++) {
            let distance = LaunchkeyMK4.colorDistance(target, LaunchkeyMK4.paletteHsv(i));
            if (distance < bestDistance) {
                bestDistance = distance;
                bestIndex = i;
            }
        }
        LaunchkeyMK4.colorCache.set(key, bestIndex);
        return bestIndex;
    }

    static rgbToHsv(rgb) {
        let r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
        let max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
        let h = 0;
        if (delta > 0) {
            if (max == r)
                h = ((g - b) / delta + 6) % 6;
            else if (max == g)
                h = (b - r) / delta + 2;
            else
                h = (r - g) / delta + 4;
            h /= 6;
        }
        return { h: h, s: max > 0 ? delta / max : 0, v: max };
    }

    static paletteHsv(index) {
        if (!LaunchkeyMK4.paletteHsvCache)
            LaunchkeyMK4.paletteHsvCache = LaunchkeyMK4.kPalette.map((c, i) => LaunchkeyMK4.rgbToHsv(LaunchkeyMK4.paletteRgb(i)));
        return LaunchkeyMK4.paletteHsvCache[index];
    }

    // Hue first: a different hue is more visible on an LED than a different shade.
    // The hue only counts as far as both colors are saturated.
    static colorDistance(a, b) {
        let dh = Math.abs(a.h - b.h);
        dh = Math.min(dh, 1 - dh) * 2 * Math.min(a.s, b.s);
        let ds = a.s - b.s, dv = a.v - b.v;
        return 16 * dh * dh + 0.5 * ds * ds + 2 * dv * dv;
    }

    static colorCodeToPaletteIndex(colorCode) {
        return LaunchkeyMK4.nearestPaletteIndex(LaunchkeyMK4.colorCodeToRgb(colorCode));
    }

    static dimPaletteIndex(index) {
        if (index <= 0)
            return LaunchkeyMK4.kColorOff;
        if (index < 4)
            return LaunchkeyMK4.kColorWhiteDim;
        if (index < 60) // 14 hue groups of 4 shades: light, full, medium, dark
            return index - ((index - 4) % 4) + 3;
        let p = LaunchkeyMK4.paletteHsv(index);
        let best = LaunchkeyMK4.kColorWhiteDim;
        let bestDistance = Number.MAX_VALUE;
        for (let i = 7; i < 60; i += 4) {
            let distance = LaunchkeyMK4.colorDistance(p, LaunchkeyMK4.paletteHsv(i - 2));
            if (distance < bestDistance) {
                bestDistance = distance;
                best = i;
            }
        }
        return best;
    }

    static transliterate(text) {
        let result = "";
        for (const ch of String(text)) {
            let code = ch.charCodeAt(0);
            if (code >= 0x20 && code <= 0x7E) {
                result += ch;
                continue;
            }
            let lower = ch.toLowerCase();
            let mapped = LaunchkeyMK4.kTransliteration[lower];
            if (mapped === undefined) {
                let stripped = "";
                try {
                    stripped = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                }
                catch (e) {
                    stripped = "";
                }
                mapped = /^[\x20-\x7E]+$/.test(stripped) ? stripped.toLowerCase() : "";
            }
            if (mapped.length > 0 && ch != lower)
                mapped = mapped.charAt(0).toUpperCase() + mapped.substring(1);
            result += mapped;
        }
        return result;
    }

    static toDisplayText(text, maxLength = LaunchkeyMK4.kDisplayMaxChars) {
        if (text === null || text === undefined)
            return "";
        let ascii = LaunchkeyMK4.transliterate(text).replace(/\s+/g, " ").trim();
        if (ascii == "-oo")
            ascii = "-inf";
        return ascii.length > maxLength ? ascii.substring(0, maxLength) : ascii;
    }

    static formatLevel(text) {
        let value = String(text === null || text === undefined ? "" : text).trim();
        if (value == "-oo" || value == "-inf")
            return "-inf dB";
        if (/^[+-]?\d+(\.\d+)?$/.test(value))
            return value + " dB";
        if (/^[+-]?\d+(\.\d+)?dB$/i.test(value))
            return value.replace(/dB$/i, " dB");
        return value;
    }
}

LaunchkeyMK4.colorCache = new Map();

// SysEx (F0 is added by PreSonus.SysexBuffer.begin)
LaunchkeyMK4.kSysexHeader = [0x00, 0x20, 0x29, 0x02, 0x14];
LaunchkeyMK4.kSysexDawConnect = 0x02;
LaunchkeyMK4.kSysexDisplayConfig = 0x04;
LaunchkeyMK4.kSysexDisplayText = 0x06;

// DAW mode on/off: note 0x0C on channel 16, DAW port
LaunchkeyMK4.kStatusDawMode = 0x9F;
LaunchkeyMK4.kDawModeNote = 0x0C;
LaunchkeyMK4.kOn = 0x7F;
LaunchkeyMK4.kOff = 0x00;

// Status bytes
LaunchkeyMK4.kStatusButton = 0xB0;          // DAW buttons, channel 1 (LED: static color)
LaunchkeyMK4.kStatusButtonFlash = 0xB1;     // channel 2 (LED: flashing color)
LaunchkeyMK4.kStatusButtonPulse = 0xB2;     // channel 3 (LED: pulsing color)
LaunchkeyMK4.kStatusPad = 0x90;             // DAW pads, channel 1 (LED: static color)
LaunchkeyMK4.kStatusPadFlash = 0x91;
LaunchkeyMK4.kStatusPadPulse = 0x92;
LaunchkeyMK4.kStatusAnalog = 0xBF;          // encoders and faders, channel 16
LaunchkeyMK4.kStatusFeature = 0xB6;         // feature controls / mode reports, channel 7
LaunchkeyMK4.kStatusFeatureQuery = 0xB7;    // feature control queries, channel 8

// Feature controls (channel 7)
LaunchkeyMK4.kFeaturePadLayout = 0x1D;
LaunchkeyMK4.kFeatureEncoderLayout = 0x1E;
LaunchkeyMK4.kFeatureFaderLayout = 0x1F;
LaunchkeyMK4.kFeatureShift = 0x3F;
// Alternative report CCs, Ableton's Launchkey MK4 script treats them like the primary ones.
LaunchkeyMK4.kFeaturePadLayoutAlt = 0x40;
LaunchkeyMK4.kFeatureEncoderLayoutAlt = 0x41;
LaunchkeyMK4.kFeatureFaderLayoutAlt = 0x42;
LaunchkeyMK4.kFeatureShiftAlt = 0x48;
LaunchkeyMK4.kFeatureEncoderRelative = 0x45;
LaunchkeyMK4.kFeatureFaderPickup = 0x46;
LaunchkeyMK4.kFeatureTouchEvents = 0x47;
LaunchkeyMK4.kFeatureDawDrumRack = 0x54;
LaunchkeyMK4.kFeatureDisplayTimeout = 0x71; // temporary display timeout, 1/10 s (query only)

// Buttons (CC, channel 1)
LaunchkeyMK4.kButtonTrackLeft = 0x67;
LaunchkeyMK4.kButtonTrackRight = 0x66;
LaunchkeyMK4.kButtonTrackLeftShifted = 0x6D;   // sent instead of 0x67 while Shift is held
LaunchkeyMK4.kButtonTrackRightShifted = 0x6C;  // sent instead of 0x66 while Shift is held
LaunchkeyMK4.kButtonPadUp = 0x6A;
LaunchkeyMK4.kButtonPadDown = 0x6B;
LaunchkeyMK4.kButtonSceneLaunch = 0x68;
LaunchkeyMK4.kButtonFunction = 0x69;
LaunchkeyMK4.kButtonParamUp = 0x33;
LaunchkeyMK4.kButtonParamDown = 0x34;
LaunchkeyMK4.kButtonTrackFirst = 0x25;      // 8 fader buttons 0x25..0x2C
LaunchkeyMK4.kButtonArmSelect = 0x2D;
LaunchkeyMK4.kButtonCapture = 0x4A;
LaunchkeyMK4.kButtonQuantize = 0x4B;
LaunchkeyMK4.kButtonMetronome = 0x4C;
LaunchkeyMK4.kButtonUndo = 0x4D;
LaunchkeyMK4.kButtonPlay = 0x73;
LaunchkeyMK4.kButtonStop = 0x74;
LaunchkeyMK4.kButtonRecord = 0x75;
LaunchkeyMK4.kButtonLoop = 0x76;

// Analog controls (channel 16)
LaunchkeyMK4.kEncoderFirst = 0x15;          // absolute: Plugin, Mixer, Sends modes
LaunchkeyMK4.kEncoderRelativeFirst = 0x55;  // relative (64 = no movement): Transport mode
LaunchkeyMK4.kEncoderCount = 8;
LaunchkeyMK4.kFaderFirst = 0x05;            // 0x05..0x0C channel faders, 0x0D master
LaunchkeyMK4.kFaderCount = 9;
LaunchkeyMK4.kRelativeCenter = 0x40;
LaunchkeyMK4.kMaxRelativeSteps = 4;

// Pads (notes, channel 1)
LaunchkeyMK4.kPadTopRowNote = 0x60;
LaunchkeyMK4.kPadBottomRowNote = 0x70;
LaunchkeyMK4.kPadsPerRow = 8;
LaunchkeyMK4.kPadCount = 16;

// Display
LaunchkeyMK4.kDisplayStationary = 0x20;
LaunchkeyMK4.kDisplayGlobalTemp = 0x21;
LaunchkeyMK4.kDisplayPadModeName = 0x22;
LaunchkeyMK4.kDisplayMixerModeName = 0x24;
LaunchkeyMK4.kDisplayCancel = 0x00;
LaunchkeyMK4.kDisplayShow = 0x7F;
LaunchkeyMK4.kDisplayAutoTriggers = 0x60;   // bit 6: on change, bit 5: on touch
LaunchkeyMK4.kArrangementNameValue = 1;     // 2 lines: name, value
LaunchkeyMK4.kArrangementTitleNameValue = 2;// 3 lines: title, name, value
LaunchkeyMK4.kArrangementEightNames = 3;    // title + 8 short names
LaunchkeyMK4.kDisplayMaxChars = 16;
LaunchkeyMK4.kDisplayShowWindowMs = 600;

// Device modes as reported on channel 7
LaunchkeyMK4.PadMode = { kDrum: 1, kDAW: 2, kUserChord: 4, kArpPattern: 13, kChordMap: 14, kDAWDrum: 15 };
LaunchkeyMK4.EncoderMode = { kMixer: 1, kPlugin: 2, kSends: 4, kTransport: 5 };
LaunchkeyMK4.FaderMode = { kVolume: 1 };

// Script pages / modes (component params)
LaunchkeyMK4.PadPage = { kLauncher: 0, kMixer: 1 };
LaunchkeyMK4.MixerPage = { kVolume: 0, kPan: 1 };
LaunchkeyMK4.FaderButtonMode = { kSelect: 0, kArm: 1 };
LaunchkeyMK4.kSendSlotCount = 8;

// Palette indices
LaunchkeyMK4.kColorOff = 0;
LaunchkeyMK4.kColorWhiteDim = 1;
LaunchkeyMK4.kColorWhiteMid = 2;
LaunchkeyMK4.kColorWhite = 3;
LaunchkeyMK4.kColorRed = 5;
LaunchkeyMK4.kColorRedDim = 7;
LaunchkeyMK4.kColorOrange = 9;
LaunchkeyMK4.kColorYellow = 13;
LaunchkeyMK4.kColorYellowDim = 15;
LaunchkeyMK4.kColorGreen = 21;
LaunchkeyMK4.kColorGreenDim = 23;
LaunchkeyMK4.kColorBlue = 41;
LaunchkeyMK4.kColorBlueDim = 43;

// Novation 128 colour palette: the colour table of the Launchkey MK4 Programmer's Reference Guide
// v3.0 (page 15), converted to approximate LED colours by tools/gen_palette.py. Index 0 is "off".
LaunchkeyMK4.kPalette = [
    0x000000, 0x3C3C3C, 0x969696, 0xFFFFFF, 0xFF3C3C, 0xFF0000, 0x960000, 0x3C0000,
    0xFFD681, 0xFF3C00, 0x960F00, 0x3C0300, 0xFFC723, 0xFFFF00, 0x969600, 0x3C3C00,
    0x96FF23, 0x57FF00, 0x239600, 0x083C00, 0x57FF3C, 0x00FF00, 0x009600, 0x003C00,
    0x57FF57, 0x00FF0F, 0x009603, 0x003C01, 0x57FF6C, 0x00FF6C, 0x009623, 0x003C08,
    0x57FFD6, 0x00FFB7, 0x009657, 0x003C17, 0x57D6FF, 0x00C7FF, 0x006196, 0x00233C,
    0x5796FF, 0x0061FF, 0x002396, 0x00083C, 0x230FFF, 0x0000FF, 0x000096, 0x00003C,
    0x6C3CFF, 0x2300FF, 0x080096, 0x03003C, 0xFF3CFF, 0xFF00FF, 0x960096, 0x3C003C,
    0xFF3C81, 0xFF0057, 0x960023, 0x3C000F, 0xFF0300, 0xB73C00, 0x965700, 0x232300,
    0x003C00, 0x003C0F, 0x000F81, 0x0000FF, 0x003C3C, 0x0F00D6, 0x6C3C57, 0x0F0308,
    0xFF0000, 0xD6FF23, 0xC7F400, 0x6CFF00, 0x039600, 0x00FF6C, 0x00B7FF, 0x0023FF,
    0x0F00FF, 0x6C00F4, 0xC70F96, 0x230300, 0xFF2300, 0x96EA00, 0x81FF0F, 0x00FF00,
    0x3CFF23, 0x6CF481, 0x3CFFE0, 0x6CA9FF, 0x2357E0, 0x8157EA, 0xEA0FFF, 0xFF006C,
    0xFF5700, 0xD6C700, 0xA9FF00, 0x966C00, 0x3C2300, 0x004803, 0x03570F, 0x080823,
    0x080F6C, 0x6C2F08, 0x960000, 0xEA3C23, 0xEA4803, 0xFFD60F, 0xB7EA23, 0x81C703,
    0x080823, 0xEAEA81, 0x96F4A9, 0xB7B7FF, 0xA981FF, 0x3C3C3C, 0x818181, 0xEAFFFF,
    0xB70000, 0x2F0000, 0x08E000, 0x003C00, 0xD6C700, 0x3C2300, 0xC75700, 0x570300
];

// The display only supports ASCII 0x20..0x7E
LaunchkeyMK4.kTransliteration = {
    "\u0430": "a", "\u0431": "b", "\u0432": "v", "\u0433": "g", "\u0434": "d", "\u0435": "e", "\u0451": "e", "\u0436": "zh",
    "\u0437": "z", "\u0438": "i", "\u0439": "y", "\u043a": "k", "\u043b": "l", "\u043c": "m", "\u043d": "n", "\u043e": "o",
    "\u043f": "p", "\u0440": "r", "\u0441": "s", "\u0442": "t", "\u0443": "u", "\u0444": "f", "\u0445": "kh", "\u0446": "ts",
    "\u0447": "ch", "\u0448": "sh", "\u0449": "sch", "\u044a": "", "\u044b": "y", "\u044c": "", "\u044d": "e", "\u044e": "yu",
    "\u044f": "ya", "\u0456": "i", "\u0457": "yi", "\u0454": "ye", "\u0491": "g", "\u045e": "u",
    "\u00df": "ss", "\u00e6": "ae", "\u00f8": "o", "\u0153": "oe", "\u0142": "l", "\u0111": "d",
    "\u2013": "-", "\u2014": "-", "\u2026": "...", "\u00ab": "\"", "\u00bb": "\"", "\u201e": "\"", "\u201c": "\"", "\u201d": "\"",
    "\u2018": "'", "\u2019": "'", "\u2022": "*", "\u00d7": "x", "\u00b0": "o", "\u221e": "inf", "\u266d": "b", "\u266f": "#",
    "\u00a0": " "
};
