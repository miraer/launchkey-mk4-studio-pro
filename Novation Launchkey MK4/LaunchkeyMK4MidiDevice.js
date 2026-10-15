//************************************************************************************************
//
// Novation Launchkey MK4 - DAW port MIDI device
// Custom control surface integration for Fender Studio Pro
//
// Responsibilities: DAW mode handshake, LED feedback, screen output, device mode tracking,
// and routing of controls whose meaning depends on Shift or the current pad/encoder mode.
// Screen texts with Cyrillic letters are drawn as pictures (LaunchkeyMK4Screen.js).
//
//************************************************************************************************

include_file("resource://com.presonus.musicdevices/sdk/midiprotocol.js");
include_file("resource://com.presonus.musicdevices/sdk/controlsurfacedevice.js");
include_file("LaunchkeyMK4Protocol.js");
include_file("LaunchkeyMK4Font.js");
include_file("LaunchkeyMK4Screen.js");

// Fader pickup (soft takeover) of the Launchkey firmware. Off: faders always send their physical
// position, like in Ableton and Bitwig. On: a fader only takes over once it reaches the DAW value.
var kLaunchkeyMK4FaderPickup = false;

//************************************************************************************************
// Control handlers
//************************************************************************************************

class LKDeviceCallbackHandler extends PreSonus.ControlHandler {
    constructor(name, callback) {
        super(name);
        this.callback = callback;
    }
    sendValue(value, flags) {
        this.callback(value, flags);
    }
}

class LKDeviceButtonLedHandler extends PreSonus.ControlHandler {
    constructor(name, cc, onColor, offColor) {
        super(name);
        this.cc = cc;
        this.onColor = onColor;
        this.offColor = offColor;
    }
    sendValue(value, flags) {
        let active = value > 0.5 && !(flags & PreSonus.ControlValue.kDisabled);
        this.device.setButtonLed(this.cc, active ? this.onColor : this.offColor);
    }
}

class LKDeviceVirtualButton extends PreSonus.ControlHandler {
    trigger() {
        this.updateValue(1);
        this.updateValue(0);
    }
}

class LKDeviceFeatureReport extends PreSonus.ControlHandler {
    constructor(name, ccs, callback) {
        super(name);
        this.ccs = ccs;
        this.callback = callback;
    }
    receiveMidi(status, data1, data2) {
        if (status != LaunchkeyMK4.kStatusFeature || this.ccs.indexOf(data1) < 0)
            return false;
        this.callback(data2);
        this.updateValue(data2);
        return true;
    }
}

//************************************************************************************************
// State
//************************************************************************************************

class LKDeviceTrackState {
    constructor() {
        this.present = false;
        this.colorIndex = LaunchkeyMK4.kColorWhite;
        this.selected = false;
        this.armed = false;
        this.armAvailable = true;
        this.muted = false;
        this.soloed = false;
    }
}

class LKDeviceLauncherPad {
    constructor() {
        this.state = false;
        this.animation = PreSonus.PadSectionPadAnimation.kNone;
        this.colorIndex = LaunchkeyMK4.kColorWhite;
    }
}

//************************************************************************************************
// LaunchkeyMK4MidiDevice
//************************************************************************************************

class LaunchkeyMK4MidiDevice extends PreSonus.ControlSurfaceDevice {
    constructor() {
        super();
        const LK = LaunchkeyMK4;
        this.shiftPressed = false;
        this.padMode = LK.PadMode.kDAW;
        this.encoderMode = LK.EncoderMode.kPlugin;
        this.faderMode = LK.FaderMode.kVolume;
        this.padPage = LK.PadPage.kLauncher;
        this.sceneView = false;
        this.faderButtonMode = LK.FaderButtonMode.kSelect;
        this.mixerPage = LK.MixerPage.kVolume;
        this.sendIndex = 0;
        this.pageNumber = 0;
        this.pageCount = 0;
        this.selectedTrackName = "";
        this.focusDeviceName = "";
        this.tempoText = "";
        this.bankOffset = 0;
        this.bankCount = 0;
        this.bankOverviewDue = 0;           // time to show the channels on the faders, 0: none
        this.bankOverviewAfterShift = false;
        this.tracks = [];
        for (let i = 0; i < LK.kPadsPerRow; i++)
            this.tracks.push(new LKDeviceTrackState());
        this.launcherPads = [];
        for (let i = 0; i < LK.kPadCount; i++)
            this.launcherPads.push(new LKDeviceLauncherPad());
        this.refreshDueTime = 0;
        this.layoutQueryTime = 0;
        this.rawTexts = {};
        this.updatingDisplayConfig = false;
        this.screen = new LKScreen(this);
        this.resetCaches();
    }

    resetCaches() {
        this.buttonLeds = {};
        this.padLeds = new Array(LaunchkeyMK4.kPadCount).fill(null);
        this.displayTexts = {};
        this.displayConfigs = {};
        this.bitmapTargets = {};
        this.lastTouchTime = {};
        this.screen.reset();
    }

    onInit(hostDevice) {
        super.onInit(hostDevice);
        this.debugLog = false;
        const LK = LaunchkeyMK4;

        // Mode reports sent by the Launchkey on channel 7
        this.addReceiveHandler(new LKDeviceFeatureReport("padModeReceiver", [LK.kFeaturePadLayout, LK.kFeaturePadLayoutAlt], (v) => this.onPadModeReport(v)));
        this.addReceiveHandler(new LKDeviceFeatureReport("encoderModeReceiver", [LK.kFeatureEncoderLayout, LK.kFeatureEncoderLayoutAlt], (v) => this.onEncoderModeReport(v)));
        this.addReceiveHandler(new LKDeviceFeatureReport("faderModeReceiver", [LK.kFeatureFaderLayout, LK.kFeatureFaderLayoutAlt], (v) => this.onFaderModeReport(v)));

        // Virtual controls triggered from script
        this.bankLeftButton = this.addVirtualButton("bankLeft");
        this.bankRightButton = this.addVirtualButton("bankRight");
        this.encoderIncButtons = [];
        this.encoderDecButtons = [];
        for (let i = 0; i < LK.kEncoderCount; i++) {
            this.encoderIncButtons.push(this.addVirtualButton(`encInc[${i}]`));
            this.encoderDecButtons.push(this.addVirtualButton(`encDec[${i}]`));
        }

        // Transport LEDs
        this.addHandler(new LKDeviceButtonLedHandler("playLED", LK.kButtonPlay, LK.kColorWhite, LK.kColorWhiteDim));
        this.addHandler(new LKDeviceButtonLedHandler("stopLED", LK.kButtonStop, LK.kColorWhite, LK.kColorWhiteDim));
        this.addHandler(new LKDeviceButtonLedHandler("recordLED", LK.kButtonRecord, LK.kColorWhite, LK.kColorWhiteDim));
        this.addHandler(new LKDeviceButtonLedHandler("loopLED", LK.kButtonLoop, LK.kColorWhite, LK.kColorWhiteDim));
        this.addHandler(new LKDeviceButtonLedHandler("metronomeLED", LK.kButtonMetronome, LK.kColorWhite, LK.kColorWhiteDim));

        // Script state mirrored from the component
        this.addCallback("padPageState", (v) => this.setPadPage(Math.round(v)));
        this.addCallback("sceneViewState", (v) => this.setSceneView(v > 0.5));
        this.addCallback("faderButtonModeState", (v) => this.setFaderButtonMode(Math.round(v)));
        this.addCallback("mixerPageState", (v) => this.setMixerPage(Math.round(v)));
        this.addCallback("sendIndexState", (v) => this.setSendIndex(Math.round(v)));
        this.addCallback("pageNumberState", (v) => this.setPageNumber(Math.round(v)));
        this.addCallback("pageCountState", (v) => { this.pageCount = Math.round(v); });
        this.addCallback("bankOffsetState", (v) => { this.bankOffset = Math.max(0, Math.round(v) || 0); this.refreshBankOverview(); });
        this.addCallback("bankCountState", (v) => { this.bankCount = Math.max(0, Math.round(v) || 0); this.refreshBankOverview(); });

        // Mixer channel states for fader buttons and Mute/Solo pads
        for (let i = 0; i < LK.kPadsPerRow; i++) {
            this.addCallback(`trackPresent[${i}]`, (v) => this.updateTrack(i, "present", v > 0.5));
            this.addCallback(`trackColor[${i}]`, (v) => this.updateTrack(i, "colorIndex", LK.colorCodeToPaletteIndex(v)));
            this.addCallback(`trackSelected[${i}]`, (v) => this.updateTrack(i, "selected", v > 0.5));
            this.addCallback(`trackArmed[${i}]`, (v, flags) => {
                this.updateTrack(i, "armAvailable", !(flags & PreSonus.ControlValue.kDisabled));
                this.updateTrack(i, "armed", v > 0.5);
            });
            this.addCallback(`trackMuted[${i}]`, (v) => this.updateTrack(i, "muted", v > 0.5));
            this.addCallback(`trackSoloed[${i}]`, (v) => this.updateTrack(i, "soloed", v > 0.5));
        }

        // Launcher pad LEDs (pad section order: bottom row first)
        for (let i = 0; i < LK.kPadsPerRow; i++) {
            this.addLauncherPadHandlers("lpBottom", i, i);
            this.addLauncherPadHandlers("lpTop", i, i + LK.kPadsPerRow);
        }

        // Screen
        for (let i = 0; i < LK.kEncoderCount; i++) {
            let target = LK.kEncoderFirst + i;
            this.addCallback(`encTitle[${i}]`, (v) => this.setControlText(target, 0, v));
            this.addCallback(`encName[${i}]`, (v) => this.setControlText(target, 1, v));
            this.addCallback(`encValue[${i}]`, (v) => this.setControlText(target, 2, this.formatEncoderValue(v)));
        }
        for (let i = 0; i < LK.kFaderCount; i++) {
            let target = LK.kFaderFirst + i;
            this.addCallback(`fdrTitle[${i}]`, (v) => { this.setControlText(target, 0, v); this.refreshBankOverview(); });
            this.addCallback(`fdrValue[${i}]`, (v) => this.setControlText(target, 2, LK.formatLevel(v)));
        }
        this.addCallback("selectedTrackName", (v) => { this.selectedTrackName = v ? String(v) : ""; this.updateStationaryDisplay(); });
        this.addCallback("focusDeviceName", (v) => this.setFocusDeviceName(v ? String(v) : ""));
        this.addCallback("tempoText", (v) => this.setTempoText(v ? String(v) : ""));
    }

    addVirtualButton(name) {
        let handler = new LKDeviceVirtualButton(name);
        this.addHandler(handler);
        return handler;
    }

    addCallback(name, callback) {
        let handler = new LKDeviceCallbackHandler(name, callback);
        this.addHandler(handler);
        return handler;
    }

    addLauncherPadHandlers(prefix, index, padIndex) {
        const kAnimation = PreSonus.PadSectionPadAnimation;
        this.addCallback(`${prefix}State[${index}]`, (v) => this.updateLauncherPad(padIndex, "state", v > 0.5));
        this.addCallback(`${prefix}Animation[${index}]`, (v) => this.updateLauncherPad(padIndex, "animation", Math.round(v) || kAnimation.kNone));
        this.addCallback(`${prefix}Color[${index}]`, (v) => this.updateLauncherPad(padIndex, "colorIndex", LaunchkeyMK4.colorCodeToPaletteIndex(v)));
    }

    //--------------------------------------------------------------------------------------------
    // Connection
    //--------------------------------------------------------------------------------------------

    onMidiOutConnected(state) {
        super.onMidiOutConnected(state);
        if (!state)
            return;
        this.resetCaches();
        this.enterDawMode();
        this.hostDevice.invalidateAll();
        this.renderAll();
        this.updateStationaryDisplay();
        this.scheduleRefresh(500);
    }

    onExit() {
        if (this.midiOutConnected)
            this.exitDawMode();
        super.onExit();
    }

    enterDawMode() {
        const LK = LaunchkeyMK4;
        // The Programmer's Reference documents the note message, Ableton and Bitwig use the SysEx one.
        this.sendSysexMessage(LK.kSysexDawConnect, [LK.kOn]);
        this.sendMidi(LK.kStatusDawMode, LK.kDawModeNote, LK.kOn);
        // Drum pads keep playing notes on the MIDI port, encoders send absolute values that follow
        // the DAW value, fader pickup as configured above.
        this.sendFeature(LK.kFeatureDawDrumRack, LK.kOff);
        this.sendFeature(LK.kFeatureEncoderRelative, LK.kOff);
        this.sendFeature(LK.kFeatureFaderPickup, kLaunchkeyMK4FaderPickup ? LK.kOn : LK.kOff);
        this.sendFeature(LK.kFeatureTouchEvents, LK.kOff);

        this.setupDisplays();

        // Ask for the current layouts and the temporary display timeout, answers arrive on channel 7.
        this.layoutQueryTime = Date.now();
        this.sendMidi(LK.kStatusFeatureQuery, LK.kFeaturePadLayout, 0);
        this.sendMidi(LK.kStatusFeatureQuery, LK.kFeatureEncoderLayout, 0);
        this.sendMidi(LK.kStatusFeatureQuery, LK.kFeatureFaderLayout, 0);
        this.sendMidi(LK.kStatusFeatureQuery, LK.kFeatureDisplayTimeout, 0);
    }

    setupDisplays() {
        const LK = LaunchkeyMK4;
        const kAuto = LK.kDisplayAutoTriggers;
        this.configureDisplay(LK.kDisplayStationary, kAuto | LK.kArrangementNameValue);
        this.configureDisplay(LK.kDisplayGlobalTemp, kAuto | LK.kArrangementNameValue);
        for (let i = 0; i < LK.kEncoderCount; i++)
            this.onControlTextsChanged(LK.kEncoderFirst + i);
        for (let i = 0; i < LK.kFaderCount; i++) {
            this.onControlTextsChanged(LK.kFaderFirst + i);
            this.setDisplayText(LK.kFaderFirst + i, 1, "Volume");
        }
        this.applyEncoderModeTexts();
        this.updatePadModeName();
        this.setDisplayText(LK.kDisplayMixerModeName, 0, this.mixerPageTitle());
    }

    // Bitmaps never reached the Launchkey: back to its text displays (transliterated). All texts
    // are sent again in case an incomplete bitmap garbled them.
    onScreenBitmapsUnavailable() {
        if (!this.midiOutConnected)
            return;
        this.displayTexts = {};
        this.displayConfigs = {};
        this.bitmapTargets = {};
        this.setupDisplays();
        this.updateStationaryDisplay();
    }

    exitDawMode() {
        const LK = LaunchkeyMK4;
        this.sendSysexMessage(LK.kSysexDisplayConfig, [LK.kDisplayStationary, LK.kDisplayCancel]);
        this.sendMidi(LK.kStatusDawMode, LK.kDawModeNote, LK.kOff);
        this.sendSysexMessage(LK.kSysexDawConnect, [LK.kOff]);
    }

    sendFeature(feature, value) {
        this.sendMidi(LaunchkeyMK4.kStatusFeature, feature, value);
    }

    sendMidi(status, data1, data2) {
        if (this.midiOutConnected && this.hostDevice)
            super.sendMidi(status, data1, data2);
    }

    onIdle(time) {
        let now = Date.now();
        if (this.refreshDueTime > 0 && now >= this.refreshDueTime) {
            this.refreshDueTime = 0;
            if (this.midiOutConnected) {
                this.hostDevice.invalidateAll();
                this.renderAll();
            }
        }
        if (this.bankOverviewDue > 0 && now >= this.bankOverviewDue) {
            this.bankOverviewDue = 0;
            this.showBankOverview();
        }
        this.screen.onIdle(now);
    }

    scheduleRefresh(delayMs = 150) {
        this.refreshDueTime = Date.now() + delayMs;
    }

    //--------------------------------------------------------------------------------------------
    // Incoming MIDI
    //--------------------------------------------------------------------------------------------

    onSysexEvent(data, length) {
        if (LKScreen.isAck(data, length)) {
            this.screen.onAck();
            return true;
        }
        return super.onSysexEvent(data, length);
    }

    onMidiEvent(status, data1, data2) {
        const LK = LaunchkeyMK4;
        if (status == LK.kStatusFeature && (data1 == LK.kFeatureShift || data1 == LK.kFeatureShiftAlt)) {
            this.shiftPressed = data2 > 0;
            this.screen.setShift(this.shiftPressed);
            // The Launchkey's Shift screen covers the channel list while Shift is held.
            if (!this.shiftPressed && this.bankOverviewAfterShift) {
                this.bankOverviewAfterShift = false;
                this.bankOverviewDue = Math.max(this.bankOverviewDue, Date.now() + LKScreen.kShiftRedrawDelayMs);
            }
            return false; // also handled by the surface XML
        }
        if (status == LK.kStatusFeature && data1 == LK.kFeatureDisplayTimeout) {
            this.screen.setPopupTimeout(data2);
            return true;
        }

        if (status == LK.kStatusAnalog) {
            if (data1 >= LK.kEncoderRelativeFirst && data1 < LK.kEncoderRelativeFirst + LK.kEncoderCount) {
                this.onRelativeEncoder(data1 - LK.kEncoderRelativeFirst, data2);
                return true;
            }
            if (this.isControlTarget(data1)) {
                this.lastTouchTime[data1] = Date.now();
                let result = super.onMidiEvent(status, data1, data2);
                this.onControlActivity(data1, false);
                return result;
            }
            return super.onMidiEvent(status, data1, data2);
        }

        if (status == LK.kStatusButton) {
            let pressed = data2 > 0;
            switch (data1) {
                case LK.kButtonTrackLeftShifted:
                case LK.kButtonTrackRightShifted:
                    if (pressed)
                        this.scrollMixerBank(data1 == LK.kButtonTrackLeftShifted ? -1 : 1);
                    return true;
                case LK.kButtonPadUp:
                case LK.kButtonPadDown:
                    if (this.padPage == LK.PadPage.kMixer) {
                        if (pressed)
                            this.scrollMixerBank(data1 == LK.kButtonPadUp ? -1 : 1);
                        return true;
                    }
                    break;
                case LK.kButtonParamUp:
                case LK.kButtonParamDown:
                    // New page or send slot: forget old texts before the host sends the new ones.
                    if (pressed && (this.encoderMode == LK.EncoderMode.kPlugin || this.encoderMode == LK.EncoderMode.kSends))
                        this.clearEncoderTexts();
                    break;
            }
        }
        return super.onMidiEvent(status, data1, data2);
    }

    onRelativeEncoder(index, value) {
        const LK = LaunchkeyMK4;
        if (this.encoderMode != LK.EncoderMode.kTransport)
            return;
        let delta = value - LK.kRelativeCenter;
        if (delta == 0)
            return;
        let steps = Math.min(Math.abs(delta), LK.kMaxRelativeSteps);
        let button = delta > 0 ? this.encoderIncButtons[index] : this.encoderDecButtons[index];
        for (let s = 0; s < steps; s++)
            button.trigger();
        let target = LK.kEncoderFirst + index;
        this.lastTouchTime[target] = Date.now();
        this.onControlActivity(target, true);
    }

    // An encoder or fader moved: its display is either the Launchkey's own one, brought up
    // automatically (or explicitly), or a picture when its texts contain Cyrillic.
    onControlActivity(target, explicitShow) {
        if (this.bitmapTargets[target])
            this.screen.showPopup(target, LKScreenRenderer.kTitleNameValue, this.controlTexts(target));
        else if (explicitShow)
            this.showDisplay(target);
        else
            this.screen.noteKeyboardPopup(target);
    }

    scrollMixerBank(direction) {
        this.clearStripTexts();
        if (direction < 0)
            this.bankLeftButton.trigger();
        else
            this.bankRightButton.trigger();
        this.scheduleRefresh();
        // Shown once the new channel names have arrived, again after Shift is released.
        this.bankOverviewDue = Date.now() + LaunchkeyMK4MidiDevice.kBankOverviewDelayMs;
        if (this.shiftPressed)
            this.bankOverviewAfterShift = true;
    }

    //--------------------------------------------------------------------------------------------
    // Device modes
    //--------------------------------------------------------------------------------------------

    onPadModeReport(mode) {
        if (mode == this.padMode)
            return;
        this.padMode = mode;
        if (mode == LaunchkeyMK4.PadMode.kDAW) {
            this.padLeds.fill(null);
            this.renderPads();
        }
        this.noteModeDisplay();
        this.scheduleRefresh();
    }

    onEncoderModeReport(mode) {
        if (mode == this.encoderMode)
            return;
        this.encoderMode = mode;
        // Custom modes are owned by the Launchkey: leave its own parameter names visible.
        this.clearEncoderTexts(this.isDawEncoderMode() ? "-" : "");
        this.applyEncoderModeTexts();
        this.renderParamLeds();
        this.updateStationaryDisplay();
        this.noteModeDisplay();
        this.scheduleRefresh();
    }

    onFaderModeReport(mode) {
        if (mode == this.faderMode)
            return;
        this.faderMode = mode;
        const LK = LaunchkeyMK4;
        let volume = mode == LK.FaderMode.kVolume;
        for (let i = 0; i < LK.kFaderCount; i++) {
            let target = LK.kFaderFirst + i;
            this.setDisplayText(target, 1, volume ? "Volume" : "");
            if (!volume) {
                this.setDisplayText(target, 0, "");
                this.setDisplayText(target, 2, "");
            }
        }
        this.noteModeDisplay();
        this.scheduleRefresh();
    }

    // A mode changed on the Launchkey brings up its mode display; replies to our queries do not.
    noteModeDisplay() {
        if (Date.now() - this.layoutQueryTime > LaunchkeyMK4MidiDevice.kQueryReplyWindowMs)
            this.screen.noteKeyboardPopup(-1);
    }

    isDawEncoderMode() {
        const kMode = LaunchkeyMK4.EncoderMode;
        return [kMode.kMixer, kMode.kPlugin, kMode.kSends, kMode.kTransport].indexOf(this.encoderMode) >= 0;
    }

    //--------------------------------------------------------------------------------------------
    // Script state
    //--------------------------------------------------------------------------------------------

    setPadPage(page) {
        if (page == this.padPage)
            return;
        this.padPage = page;
        this.renderPads();
        this.renderPadAreaLeds();
        this.updatePadModeName();
        this.showNotification("Pads", page == LaunchkeyMK4.PadPage.kMixer ? "Mute / Solo" : "Launcher");
    }

    setSceneView(state) {
        if (state == this.sceneView)
            return;
        this.sceneView = state;
        this.renderPadAreaLeds();
        this.updatePadModeName();
        this.showNotification("Launcher", state ? "Scenes" : "Clips");
    }

    setFaderButtonMode(mode) {
        if (mode == this.faderButtonMode)
            return;
        this.faderButtonMode = mode;
        this.renderTrackButtons();
        this.showNotification("Fader Buttons", mode == LaunchkeyMK4.FaderButtonMode.kArm ? "Arm" : "Select");
    }

    setMixerPage(page) {
        if (page == this.mixerPage)
            return;
        this.mixerPage = page;
        this.renderParamLeds();
        this.setDisplayText(LaunchkeyMK4.kDisplayMixerModeName, 0, this.mixerPageTitle());
        if (this.encoderMode == LaunchkeyMK4.EncoderMode.kMixer) {
            this.applyEncoderModeTexts();
            this.updateStationaryDisplay();
            this.showNotification("Mixer", this.mixerPageTitle());
        }
    }

    setSendIndex(index) {
        if (index == this.sendIndex)
            return;
        this.sendIndex = index;
        if (this.encoderMode == LaunchkeyMK4.EncoderMode.kSends) {
            this.updateStationaryDisplay();
            this.showNotification("Sends", this.sendTitle());
        }
    }

    setPageNumber(pageNumber) {
        if (pageNumber == this.pageNumber)
            return;
        let previous = this.pageNumber;
        this.pageNumber = pageNumber;
        if (this.encoderMode == LaunchkeyMK4.EncoderMode.kPlugin && pageNumber > 0 && previous > 0) {
            let text = this.pageCount > 0 ? `Page ${pageNumber} / ${this.pageCount}` : `Page ${pageNumber}`;
            this.showNotification(this.focusDeviceName || "Plugin", text);
        }
    }

    setFocusDeviceName(name) {
        if (name == this.focusDeviceName)
            return;
        this.focusDeviceName = name;
        if (this.encoderMode == LaunchkeyMK4.EncoderMode.kPlugin) {
            this.applyEncoderModeTexts();
            this.updateStationaryDisplay();
        }
    }

    setTempoText(text) {
        this.tempoText = text;
        if (this.encoderMode == LaunchkeyMK4.EncoderMode.kTransport)
            this.setControlText(LaunchkeyMK4.kEncoderFirst + 7, 2, text);
    }

    updateTrack(index, key, value) {
        let track = this.tracks[index];
        if (track[key] === value)
            return;
        track[key] = value;
        this.renderTrackButton(index);
        this.renderPad(index);
        this.renderPad(index + LaunchkeyMK4.kPadsPerRow);
        if (key == "present")
            this.refreshBankOverview();
    }

    updateLauncherPad(padIndex, key, value) {
        let pad = this.launcherPads[padIndex];
        if (pad[key] === value)
            return;
        pad[key] = value;
        this.renderPad(padIndex);
    }

    //--------------------------------------------------------------------------------------------
    // LEDs
    //--------------------------------------------------------------------------------------------

    setButtonLed(cc, color) {
        if (this.buttonLeds[cc] === color)
            return;
        this.buttonLeds[cc] = color;
        this.sendMidi(LaunchkeyMK4.kStatusButton, cc, color);
    }

    renderAll() {
        this.renderPads();
        this.renderTrackButtons();
        this.renderPadAreaLeds();
        this.renderParamLeds();
        const LK = LaunchkeyMK4;
        for (const cc of [LK.kButtonTrackLeft, LK.kButtonTrackRight, LK.kButtonCapture, LK.kButtonQuantize, LK.kButtonUndo])
            this.setButtonLed(cc, LK.kColorWhiteDim);
    }

    renderPadAreaLeds() {
        const LK = LaunchkeyMK4;
        let launcher = this.padPage == LK.PadPage.kLauncher;
        this.setButtonLed(LK.kButtonPadUp, LK.kColorWhiteDim);
        this.setButtonLed(LK.kButtonPadDown, LK.kColorWhiteDim);
        this.setButtonLed(LK.kButtonSceneLaunch, launcher && this.sceneView ? LK.kColorWhite : LK.kColorWhiteDim);
        this.setButtonLed(LK.kButtonFunction, launcher ? LK.kColorWhiteDim : LK.kColorWhite);
    }

    renderParamLeds() {
        const LK = LaunchkeyMK4;
        let up = LK.kColorOff, down = LK.kColorOff;
        switch (this.encoderMode) {
            case LK.EncoderMode.kPlugin:
            case LK.EncoderMode.kSends:
                up = down = LK.kColorWhiteDim;
                break;
            case LK.EncoderMode.kMixer:
                up = this.mixerPage == LK.MixerPage.kVolume ? LK.kColorWhite : LK.kColorWhiteDim;
                down = this.mixerPage == LK.MixerPage.kPan ? LK.kColorWhite : LK.kColorWhiteDim;
                break;
            case LK.EncoderMode.kTransport:
                up = LK.kColorWhiteDim; // insert marker
                break;
        }
        this.setButtonLed(LK.kButtonParamUp, up);
        this.setButtonLed(LK.kButtonParamDown, down);
    }

    renderTrackButtons() {
        for (let i = 0; i < LaunchkeyMK4.kPadsPerRow; i++)
            this.renderTrackButton(i);
        let arm = this.faderButtonMode == LaunchkeyMK4.FaderButtonMode.kArm;
        this.setButtonLed(LaunchkeyMK4.kButtonArmSelect, arm ? LaunchkeyMK4.kColorRed : LaunchkeyMK4.kColorWhite);
    }

    renderTrackButton(index) {
        const LK = LaunchkeyMK4;
        let track = this.tracks[index];
        let color = LK.kColorOff;
        if (track.present) {
            if (this.faderButtonMode == LK.FaderButtonMode.kArm)
                color = !track.armAvailable ? LK.kColorOff : (track.armed ? LK.kColorRed : LK.kColorRedDim);
            else
                color = track.selected ? LK.kColorWhite : LK.dimPaletteIndex(track.colorIndex);
        }
        this.setButtonLed(LK.kButtonTrackFirst + index, color);
    }

    renderPads() {
        for (let i = 0; i < LaunchkeyMK4.kPadCount; i++)
            this.renderPad(i);
    }

    renderPad(padIndex) {
        const LK = LaunchkeyMK4;
        if (this.padMode != LK.PadMode.kDAW)
            return;
        let status = LK.kStatusPad;
        let color = LK.kColorOff;
        let flashColor = -1;
        if (this.padPage == LK.PadPage.kMixer) {
            let track = this.tracks[padIndex % LK.kPadsPerRow];
            if (track.present) {
                if (padIndex >= LK.kPadsPerRow) // top row: mute
                    color = track.muted ? LK.kColorBlue : LK.kColorBlueDim;
                else // bottom row: solo
                    color = track.soloed ? LK.kColorYellow : LK.kColorYellowDim;
            }
        }
        else {
            let pad = this.launcherPads[padIndex];
            if (pad.state) {
                color = pad.colorIndex;
                if (pad.animation == PreSonus.PadSectionPadAnimation.kBlink)
                    flashColor = LK.kColorOff;
                else if (pad.animation == PreSonus.PadSectionPadAnimation.kPulse)
                    status = LK.kStatusPadPulse;
            }
        }
        let key = `${status}:${color}:${flashColor}`;
        if (this.padLeds[padIndex] === key)
            return;
        this.padLeds[padIndex] = key;
        let note = LK.padNote(padIndex);
        this.sendMidi(status, note, color);
        if (flashColor >= 0)
            this.sendMidi(LK.kStatusPadFlash, note, flashColor);
    }

    //--------------------------------------------------------------------------------------------
    // Screen
    //--------------------------------------------------------------------------------------------

    sendSysexMessage(command, bytes, text) {
        if (!this.midiOutConnected || !this.hostDevice)
            return;
        let buffer = this.sysexSendBuffer;
        buffer.begin(LaunchkeyMK4.kSysexHeader);
        buffer.push(command);
        for (const b of bytes)
            buffer.push(b & 0x7F);
        if (text)
            buffer.appendAscii(text);
        buffer.end();
        this.sendSysex(buffer);
    }

    configureDisplay(target, config) {
        if (this.displayConfigs[target] === config)
            return false;
        this.displayConfigs[target] = config;
        for (let field = 0; field < 16; field++)
            delete this.displayTexts[target * 16 + field];
        this.sendSysexMessage(LaunchkeyMK4.kSysexDisplayConfig, [target, config]);
        return true;
    }

    showDisplay(target) {
        this.sendSysexMessage(LaunchkeyMK4.kSysexDisplayConfig, [target, LaunchkeyMK4.kDisplayShow]);
        if (target != LaunchkeyMK4.kDisplayStationary)
            this.screen.noteKeyboardPopup(target);
    }

    cancelDisplay(target) {
        this.sendSysexMessage(LaunchkeyMK4.kSysexDisplayConfig, [target, LaunchkeyMK4.kDisplayCancel]);
    }

    // Texts are kept as received (for pictures) and sent transliterated to the Launchkey.
    setDisplayText(target, field, text) {
        let key = target * 16 + field;
        let raw = text === null || text === undefined ? "" : String(text);
        let rawChanged = this.rawTexts[key] !== raw;
        this.rawTexts[key] = raw;
        let value = LaunchkeyMK4.toDisplayText(raw);
        let changed = this.displayTexts[key] !== value;
        if (changed) {
            this.displayTexts[key] = value;
            this.sendSysexMessage(LaunchkeyMK4.kSysexDisplayText, [target, field], value);
        }
        if (rawChanged && field <= 2 && this.isControlTarget(target))
            this.onControlTextsChanged(target);
        return changed;
    }

    // Text of a parameter display that pops up while an encoder or fader is moved.
    setControlText(target, field, text) {
        if (!this.setDisplayText(target, field, text) || this.bitmapTargets[target])
            return;
        let touched = this.lastTouchTime[target];
        if (touched && Date.now() - touched < LaunchkeyMK4.kDisplayShowWindowMs)
            this.showDisplay(target);
    }

    isControlTarget(target) {
        const LK = LaunchkeyMK4;
        return (target >= LK.kEncoderFirst && target < LK.kEncoderFirst + LK.kEncoderCount) ||
            (target >= LK.kFaderFirst && target < LK.kFaderFirst + LK.kFaderCount);
    }

    controlTexts(target) {
        let base = target * 16;
        return [this.rawTexts[base] || "", this.rawTexts[base + 1] || "", this.rawTexts[base + 2] || ""];
    }

    // Encoders and faders whose texts contain Cyrillic get a picture instead of the Launchkey's
    // own display, which therefore must not pop up automatically for them.
    onControlTextsChanged(target) {
        if (this.updatingDisplayConfig)
            return;
        const LK = LaunchkeyMK4;
        let texts = this.controlTexts(target);
        let bitmap = this.screen.wantsBitmap(texts);
        this.bitmapTargets[target] = bitmap;
        let config = (bitmap ? 0 : LK.kDisplayAutoTriggers) | LK.kArrangementTitleNameValue;
        if (this.displayConfigs[target] !== config) {
            this.updatingDisplayConfig = true;
            this.configureDisplay(target, config);
            for (let field = 0; field < 3; field++)
                this.setDisplayText(target, field, texts[field]);
            this.updatingDisplayConfig = false;
        }
        if (bitmap)
            this.screen.updatePopup(target, LKScreenRenderer.kTitleNameValue, texts);
    }

    showNotification(title, text) {
        if (!this.midiOutConnected)
            return;
        const LK = LaunchkeyMK4;
        if (this.screen.wantsBitmap([title, text])) {
            this.screen.showPopup(LK.kDisplayGlobalTemp, LKScreenRenderer.kNameValue, [title, text]);
            return;
        }
        this.configureDisplay(LK.kDisplayGlobalTemp, LK.kDisplayAutoTriggers | LK.kArrangementNameValue);
        this.setDisplayText(LK.kDisplayGlobalTemp, 0, title);
        this.setDisplayText(LK.kDisplayGlobalTemp, 1, text);
        this.showDisplay(LK.kDisplayGlobalTemp);
    }

    // Channels on the faders after bank scrolling: "Channels 9-16 / 20" and numbered names.
    // Always a picture, the Launchkey's 8 name display clips names to about 4 letters.
    showBankOverview() {
        if (!this.midiOutConnected)
            return;
        const LK = LaunchkeyMK4;
        let names = this.bankOverviewNames();
        if (this.screen.showPopup(LaunchkeyMK4MidiDevice.kBankOverviewId, LKScreenRenderer.kChannelList, [this.bankOverviewTitle(0)].concat(names)))
            return;
        let target = LK.kDisplayGlobalTemp;
        this.configureDisplay(target, LK.kDisplayAutoTriggers | LK.kArrangementEightNames);
        this.setDisplayText(target, 0, this.bankOverviewTitle(LK.kDisplayMaxChars));
        names.forEach((name, i) => this.setDisplayText(target, i + 1, LK.toDisplayText(name, LaunchkeyMK4MidiDevice.kBankOverviewNameChars)));
        this.showDisplay(target);
    }

    refreshBankOverview() {
        const kId = LaunchkeyMK4MidiDevice.kBankOverviewId;
        if (this.bankOverviewDue > 0 || !this.screen.hasPopup(kId))
            return;
        this.screen.updatePopup(kId, LKScreenRenderer.kChannelList, [this.bankOverviewTitle(0)].concat(this.bankOverviewNames()));
    }

    bankOverviewNames() {
        const LK = LaunchkeyMK4;
        return this.tracks.map((track, i) => track.present ? (this.rawTexts[(LK.kFaderFirst + i) * 16] || "") : "");
    }

    // maxLength 0: no limit
    bankOverviewTitle(maxLength) {
        let present = this.tracks.filter((track) => track.present).length;
        if (present == 0)
            return "No Channels";
        let first = this.bankOffset + 1;
        let last = this.bankOffset + present;
        let range = present > 1 ? `${first}-${last}` : `${first}`;
        let word = present > 1 ? "Channels" : "Channel";
        let variants = this.bankCount >= last
            ? [`${word} ${range} / ${this.bankCount}`, `${word} ${range}/${this.bankCount}`, `Ch ${range} / ${this.bankCount}`, `Ch ${range}/${this.bankCount}`]
            : [`${word} ${range}`, `Ch ${range}`];
        return variants.find((text) => maxLength <= 0 || text.length <= maxLength) || range;
    }

    formatEncoderValue(text) {
        const kMode = LaunchkeyMK4.EncoderMode;
        let volume = this.encoderMode == kMode.kMixer && this.mixerPage == LaunchkeyMK4.MixerPage.kVolume;
        if (volume || this.encoderMode == kMode.kSends)
            return LaunchkeyMK4.formatLevel(text);
        return text;
    }

    clearEncoderTexts(placeholder = "-") {
        const LK = LaunchkeyMK4;
        for (let i = 0; i < LK.kEncoderCount; i++) {
            this.setDisplayText(LK.kEncoderFirst + i, 0, "");
            this.setDisplayText(LK.kEncoderFirst + i, 1, placeholder);
            this.setDisplayText(LK.kEncoderFirst + i, 2, "");
        }
    }

    clearStripTexts() {
        const LK = LaunchkeyMK4;
        if (this.encoderMode == LK.EncoderMode.kMixer || this.encoderMode == LK.EncoderMode.kSends) {
            this.clearEncoderTexts();
            this.applyEncoderModeTexts();
        }
        for (let i = 0; i < LK.kPadsPerRow; i++) {
            this.setDisplayText(LK.kFaderFirst + i, 0, "");
            this.setDisplayText(LK.kFaderFirst + i, 2, "");
        }
    }

    mixerPageTitle() {
        return this.mixerPage == LaunchkeyMK4.MixerPage.kPan ? "Pan" : "Volume";
    }

    sendTitle() {
        return `Send ${this.sendIndex + 1}`;
    }

    // Texts owned by the script for the current encoder mode, the rest comes from the host.
    applyEncoderModeTexts() {
        const LK = LaunchkeyMK4;
        for (let i = 0; i < LK.kEncoderCount; i++) {
            let target = LK.kEncoderFirst + i;
            switch (this.encoderMode) {
                case LK.EncoderMode.kMixer:
                    this.setDisplayText(target, 1, this.mixerPageTitle());
                    break;
                case LK.EncoderMode.kPlugin:
                    this.setDisplayText(target, 0, this.focusDeviceName || "Plugin");
                    break;
                case LK.EncoderMode.kTransport: {
                    let info = LaunchkeyMK4MidiDevice.kTransportEncoders[i];
                    this.setDisplayText(target, 0, "Transport");
                    this.setDisplayText(target, 1, info[0]);
                    this.setDisplayText(target, 2, i == 7 && this.tempoText ? this.tempoText : info[1]);
                    break;
                }
            }
        }
    }

    updatePadModeName() {
        const LK = LaunchkeyMK4;
        let name = "Launcher";
        if (this.padPage == LK.PadPage.kMixer)
            name = "Mute / Solo";
        else if (this.sceneView)
            name = "Scenes";
        this.setDisplayText(LK.kDisplayPadModeName, 0, name);
    }

    updateStationaryDisplay() {
        if (!this.midiOutConnected)
            return;
        const LK = LaunchkeyMK4;
        const kMode = LK.EncoderMode;
        let target = LK.kDisplayStationary;
        let lines = null;
        let configured = false;
        if (this.encoderMode == kMode.kTransport) {
            configured = this.configureDisplay(target, LK.kDisplayAutoTriggers | LK.kArrangementEightNames);
            this.setDisplayText(target, 0, "Transport");
            LaunchkeyMK4MidiDevice.kTransportEncoders.forEach((info, i) => this.setDisplayText(target, i + 1, info[2]));
        }
        else {
            let line2 = "Custom Mode";
            if (this.encoderMode == kMode.kPlugin)
                line2 = this.focusDeviceName || "No Plugin Focus";
            else if (this.encoderMode == kMode.kMixer)
                line2 = "Mixer: " + this.mixerPageTitle();
            else if (this.encoderMode == kMode.kSends)
                line2 = "Sends: " + this.sendTitle();
            lines = [this.selectedTrackName || "Studio Pro", line2];
            configured = this.configureDisplay(target, LK.kDisplayAutoTriggers | LK.kArrangementNameValue);
            this.setDisplayText(target, 0, lines[0]);
            this.setDisplayText(target, 1, lines[1]);
        }
        if (configured)
            this.screen.invalidate();
        // Brings up the text display, or sends a picture when the lines contain Cyrillic.
        this.screen.setHome(lines);
    }
}

// Mode reports arriving this soon after our layout queries are answers, not user changes.
LaunchkeyMK4MidiDevice.kQueryReplyWindowMs = 1000;
// Channel list after bank scrolling: delay for the new channel names to arrive.
LaunchkeyMK4MidiDevice.kBankOverviewDelayMs = 250;
LaunchkeyMK4MidiDevice.kBankOverviewId = "bank";
LaunchkeyMK4MidiDevice.kBankOverviewNameChars = 4;  // Launchkey 8 name display (no pictures)

// Transport encoder mode: [name, value hint, short name for the 8-name overview]
LaunchkeyMK4MidiDevice.kTransportEncoders = [
    ["Position", "Bar < >", "Bar"],
    ["Zoom", "Horizontal", "ZmH"],
    ["Zoom", "Vertical", "ZmV"],
    ["Loop", "Shift < >", "Loop"],
    ["Marker", "Prev / Next", "Mark"],
    ["Track", "Prev / Next", "Trk"],
    ["Section", "Prev / Next", "Sect"],
    ["Tempo", "- / +", "BPM"]
];

function createLaunchkeyMK4DeviceInstance() {
    return new LaunchkeyMK4MidiDevice();
}
