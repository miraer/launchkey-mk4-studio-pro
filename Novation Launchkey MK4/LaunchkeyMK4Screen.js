//************************************************************************************************
//
// Novation Launchkey MK4 - screen pictures for texts the Launchkey font cannot show (Cyrillic)
// and for layouts it does not have (channel list of the fader bank)
// Custom control surface integration for Fender Studio Pro
//
// The Launchkey text font only covers ASCII. Screens with Cyrillic letters are drawn into a
// 128 x 64 bitmap and sent with the bitmap SysEx (Programmer's Reference v3.0, page 20):
//   F0 00 20 29 02 14 09 <target> <1216 bytes: 64 rows x 19 bytes, 7 pixels per byte> F7
// Behaviour measured on a Launchkey 49 MK4:
// - the Launchkey answers F0 00 20 29 02 14 09 F7 when a bitmap is done (70-110 ms);
//   bitmaps arriving earlier are dropped and can garble the stored display texts,
//   so only one bitmap is in flight at any time (other messages are not affected);
// - the bitmap stays until the normal stationary display is brought up again;
// - the Launchkey's own temporary displays and the Shift overlay may replace it, so it is
//   sent again once they are over (their duration is the "temporary display timeout" setting);
// - its "title + 8 names" text display clips names at 32 pixels without any gap between them.
//
//************************************************************************************************

"use strict";

class LKScreenBitmap {
    constructor() {
        this.bytes = new Uint8Array(LKScreenBitmap.kByteCount);
    }

    clear() {
        this.bytes.fill(0);
    }

    setPixel(x, y) {
        if (x < 0 || y < 0 || x >= LKScreenBitmap.kWidth || y >= LKScreenBitmap.kHeight)
            return;
        this.bytes[y * LKScreenBitmap.kRowBytes + Math.floor(x / 7)] |= 0x40 >> (x % 7);
    }
}

LKScreenBitmap.kWidth = 128;
LKScreenBitmap.kHeight = 64;
LKScreenBitmap.kRowBytes = 19;
LKScreenBitmap.kByteCount = 19 * 64;

//************************************************************************************************
// LKScreenRenderer
//************************************************************************************************

class LKScreenRenderer {
    static needsBitmap(text) {
        return LKScreenRenderer.kBitmapChars.test(LKScreenRenderer.normalize(text));
    }

    static normalize(text) {
        let value = String(text === null || text === undefined ? "" : text).replace(/\s+/g, " ").trim();
        return value == "-oo" ? "-inf" : value;
    }

    // Characters without glyph are transliterated, or replaced by '?'.
    static prepareText(font, text) {
        let result = "";
        for (const ch of text) {
            if (font.has(ch.charCodeAt(0))) {
                result += ch;
                continue;
            }
            for (const r of LaunchkeyMK4.transliterate(ch))
                result += font.has(r.charCodeAt(0)) ? r : "?";
        }
        return result;
    }

    // First font the text fits in, otherwise the last font with the text shortened.
    static fit(text, fonts, maxWidth) {
        for (const font of fonts) {
            let prepared = LKScreenRenderer.prepareText(font, text);
            if (font.measure(prepared) <= maxWidth)
                return { font: font, text: prepared };
        }
        let font = fonts[fonts.length - 1];
        let prepared = LKScreenRenderer.prepareText(font, text);
        let maxChars = Math.floor(maxWidth / font.width);
        let ellipsis = font.has(0x2026) ? "\u2026" : ".";
        return { font: font, text: prepared.substring(0, maxChars - 1) + ellipsis };
    }

    static drawLine(bitmap, text, fonts, centerY) {
        if (!text)
            return;
        let fitted = LKScreenRenderer.fit(text, fonts, LKScreenBitmap.kWidth);
        let x = Math.floor((LKScreenBitmap.kWidth - fitted.font.measure(fitted.text)) / 2);
        let y = Math.round(centerY - fitted.font.height / 2);
        fitted.font.draw(bitmap, fitted.text, x, y);
    }

    static render(bitmap, frame) {
        const F = LKBitmapFont;
        let lines = frame.lines;
        bitmap.clear();
        if (frame.layout == LKScreenRenderer.kTitleNameValue) {
            // Like the Launchkey's parameter display: title, parameter name, large value
            LKScreenRenderer.drawLine(bitmap, lines[0], [F.kBold, F.kNarrowBold, F.kSmall], 8);
            LKScreenRenderer.drawLine(bitmap, lines[1], [F.kSmall], 24);
            LKScreenRenderer.drawLine(bitmap, lines[2], [F.kLarge, F.kMediumBold, F.kBold, F.kSmall], 47);
        }
        else if (frame.layout == LKScreenRenderer.kChannelList) {
            // Title and up to 8 numbered names, 1-4 in the left column, 5-8 in the right one
            LKScreenRenderer.drawLine(bitmap, lines[0], [F.kBold, F.kNarrowBold, F.kSmall], 6.5);
            let font = F.kSmall;
            let maxChars = Math.floor(LKScreenBitmap.kWidth / 2 / font.width);
            for (let i = 0; i < 8; i++) {
                let name = lines[i + 1];
                if (!name)
                    continue;
                let text = LKScreenRenderer.prepareText(font, `${i + 1} ${name}`).substring(0, maxChars);
                font.draw(bitmap, text, (i >> 2) * (LKScreenBitmap.kWidth / 2) + 1, 14 + (i & 3) * 12);
            }
        }
        else {
            // Two lines, the second one large
            LKScreenRenderer.drawLine(bitmap, lines[0], [F.kBold, F.kNarrowBold, F.kSmall], 15);
            LKScreenRenderer.drawLine(bitmap, lines[1], [F.kLarge, F.kMediumBold, F.kBold, F.kNarrowBold, F.kSmall], 44);
        }
    }
}

LKScreenRenderer.kBitmapChars = /[\u0400-\u052F]/;
LKScreenRenderer.kNameValue = "nameValue";
LKScreenRenderer.kTitleNameValue = "titleNameValue";
LKScreenRenderer.kChannelList = "channelList";

//************************************************************************************************
// LKScreen - decides which picture the stationary display should show and sends it
//************************************************************************************************

class LKScreen {
    constructor(device) {
        this.device = device;
        this.bitmap = new LKScreenBitmap();
        let header = LKScreen.kBitmapHeader;
        this.message = new Uint8Array(header.length + 1 + LKScreenBitmap.kByteCount + 1);
        this.message.set(header, 0);
        this.message[header.length] = LaunchkeyMK4.kDisplayStationary;
        this.message[this.message.length - 1] = 0xF7;
        this.enabled = true;        // false once bitmaps turned out not to reach the Launchkey
        this.confirmed = false;     // the Launchkey acknowledged at least one bitmap
        this.failures = 0;
        this.popupMs = LKScreen.kDefaultPopupMs;
        this.home = null;
        this.reset();
    }

    reset() {
        this.inFlight = false;
        this.sentTime = 0;
        this.shownKey = null;       // picture on the screen, null: the Launchkey shows its text displays
        this.stale = false;         // the picture may have been replaced by a Launchkey display
        this.popup = null;
        this.popupUntil = 0;
        this.waitUntil = 0;         // a Launchkey temporary display is assumed visible until then
        this.waitTarget = -1;
        this.settleUntil = 0;       // no pictures until then (Launchkey's Shift screen closing)
        this.shiftHeld = false;
        this.textHomePending = false;
    }

    static isAck(data, length) {
        if (length < LKScreen.kBitmapHeader.length + 1)
            return false;
        for (let i = 0; i < LKScreen.kBitmapHeader.length; i++)
            if (data[i] != LKScreen.kBitmapHeader[i])
                return false;
        let last = data[LKScreen.kBitmapHeader.length];
        return last == 0xF7 || last == 0x7F;
    }

    static makeFrame(layout, lines, id) {
        let normalized = lines.map((line) => LKScreenRenderer.normalize(line));
        return { layout: layout, lines: normalized, id: id, key: layout + "\n" + normalized.join("\n") };
    }

    wantsBitmap(lines) {
        return this.enabled && lines.some((line) => LKScreenRenderer.needsBitmap(line));
    }

    // Feature control 71h reply: temporary display timeout in 1/10 s, at least 1 s
    setPopupTimeout(value) {
        this.popupMs = Math.max(1000, value * 100);
    }

    // Stationary display content. Lines without Cyrillic stay a text display of the Launchkey.
    setHome(lines) {
        let frame = lines && this.wantsBitmap(lines) ? LKScreen.makeFrame(LKScreenRenderer.kNameValue, lines, "home") : null;
        let oldKey = this.home ? this.home.key : null;
        this.home = frame;
        if (!frame)
            this.textHomePending = true;
        // New content is shown right away, like the text display used to be.
        if (!frame || frame.key !== oldKey)
            this.cancelKeyboardPopup();
        this.pump();
    }

    showPopup(id, layout, lines) {
        if (!this.enabled)
            return false;
        this.cancelKeyboardPopup();
        this.popup = LKScreen.makeFrame(layout, lines, id);
        this.popupUntil = Date.now() + this.popupMs;
        this.pump();
        return true;
    }

    updatePopup(id, layout, lines) {
        if (!this.hasPopup(id))
            return;
        this.popup = LKScreen.makeFrame(layout, lines, id);
        this.pump();
    }

    hasPopup(id) {
        return this.popup !== null && this.popup.id === id;
    }

    // The Launchkey shows one of its own temporary displays (target -1: unknown).
    noteKeyboardPopup(target) {
        this.popup = null;
        this.waitUntil = Date.now() + this.popupMs + LKScreen.kRedrawMarginMs;
        this.waitTarget = target;
        if (this.shownKey !== null)
            this.stale = true;
    }

    cancelKeyboardPopup() {
        if (this.waitTarget >= 0 && Date.now() < this.waitUntil)
            this.device.cancelDisplay(this.waitTarget);
        this.waitUntil = 0;
        this.waitTarget = -1;
    }

    // The stationary display was reconfigured, a picture on it may be gone.
    invalidate() {
        if (this.shownKey !== null)
            this.stale = true;
    }

    // While Shift is held the Launchkey shows its own Shift screen (pad and encoder mode).
    setShift(held) {
        if (held == this.shiftHeld)
            return;
        this.shiftHeld = held;
        if (held)
            this.popup = null;
        else {
            // Pictures may be gone with the Shift screen. Pop-ups opened while Shift was held
            // (e.g. bank overview) are shown with their full time once it is closed.
            let now = Date.now();
            if (this.popup)
                this.popupUntil = now + this.popupMs;
            this.settleUntil = now + LKScreen.kShiftRedrawDelayMs;
        }
        if (this.shownKey !== null)
            this.stale = true;
        this.pump();
    }

    onAck() {
        if (!this.inFlight)
            return;
        this.inFlight = false;
        this.confirmed = true;
        this.failures = 0;
        this.pump();
    }

    onIdle(now) {
        if (this.inFlight && now - this.sentTime > LKScreen.kAckTimeoutMs) {
            this.inFlight = false;
            this.shownKey = null;
            this.failures++;
            if ((!this.confirmed && this.failures >= LKScreen.kMaxFailuresUnconfirmed) || this.failures >= LKScreen.kMaxFailures) {
                this.disable();
                return;
            }
        }
        this.pump();
    }

    disable() {
        this.enabled = false;
        this.home = null;
        this.popup = null;
        this.inFlight = false;
        this.shownKey = null;
        this.device.onScreenBitmapsUnavailable();
    }

    pump() {
        let device = this.device;
        if (!device.midiOutConnected || !device.hostDevice || this.inFlight)
            return;
        let now = Date.now();
        if (this.popup && !this.shiftHeld && now >= this.popupUntil)
            this.popup = null;
        // The Launchkey's Shift screen covers pictures (seen on the hardware), pop-ups wait.
        if (this.shiftHeld || now < this.settleUntil)
            return;
        let frame = this.popup;
        if (!frame) {
            if (now < this.waitUntil)
                return;
            frame = this.home;
        }
        if (!frame) {
            if (this.shownKey !== null || this.textHomePending) {
                this.shownKey = null;
                this.stale = false;
                this.textHomePending = false;
                device.showDisplay(LaunchkeyMK4.kDisplayStationary);
            }
            return;
        }
        if (frame.key === this.shownKey && !this.stale)
            return;
        this.send(frame, now);
    }

    send(frame, now) {
        LKScreenRenderer.render(this.bitmap, frame);
        this.message.set(this.bitmap.bytes, LKScreen.kBitmapHeader.length + 1);
        try {
            this.device.hostDevice.sendSysexEvent(this.message, this.message.length);
        }
        catch (e) {
            this.disable();
            return;
        }
        this.inFlight = true;
        this.sentTime = now;
        this.shownKey = frame.key;
        this.stale = false;
    }
}

LKScreen.kBitmapHeader = [0xF0, 0x00, 0x20, 0x29, 0x02, 0x14, 0x09];
LKScreen.kDefaultPopupMs = 4000;
LKScreen.kRedrawMarginMs = 300;
LKScreen.kShiftRedrawDelayMs = 100;
LKScreen.kAckTimeoutMs = 600;
LKScreen.kMaxFailuresUnconfirmed = 2;
LKScreen.kMaxFailures = 5;
