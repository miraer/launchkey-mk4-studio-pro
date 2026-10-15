//************************************************************************************************
//
// Novation Launchkey MK4 - control surface component
// Custom control surface integration for Fender Studio Pro
//
// Owns the host side state: device modes, pad pages, launcher pad section,
// send slot selection and mixer bank following the selected track.
//
//************************************************************************************************

include_file("resource://com.presonus.musicdevices/sdk/controlsurfacecomponent.js");
include_file("LaunchkeyMK4Protocol.js");

class LaunchkeyMK4Component extends PreSonus.ControlSurfaceComponent {
    onInit(hostComponent) {
        super.onInit(hostComponent);
        this.debugLog = false;
        const LK = LaunchkeyMK4;
        let params = hostComponent.paramList;

        this.shiftParam = params.addParam("shiftModifier");
        this.padModeParam = params.addInteger(0, 127, "padMode");
        this.encoderModeParam = params.addInteger(0, 127, "encoderMode");
        this.faderModeParam = params.addInteger(0, 127, "faderMode");
        this.padPageParam = params.addParam("padPage");
        this.sceneViewParam = params.addParam("sceneView");
        this.mixerPageParam = params.addInteger(0, 1, "mixerPage");
        this.sendIndexParam = params.addInteger(0, LK.kSendSlotCount - 1, "sendIndex");
        this.faderButtonModeParam = params.addParam("faderButtonMode");
        this.bankOffsetParam = params.addInteger(0, LaunchkeyMK4Component.kMaxBankSize, "bankOffset");
        this.bankCountParam = params.addInteger(0, LaunchkeyMK4Component.kMaxBankSize, "bankCount");
        this.trackPresentParams = [];
        for (let i = 0; i < LK.kPadsPerRow; i++)
            this.trackPresentParams.push(params.addParam("trackPresent" + i));

        // Defaults of the Launchkey after entering DAW mode
        this.padModeParam.setValue(LK.PadMode.kDAW);
        this.encoderModeParam.setValue(LK.EncoderMode.kPlugin);
        this.faderModeParam.setValue(LK.FaderMode.kVolume);

        let root = hostComponent.model.root;
        let mixerMapping = root.find("MixerMapping");
        this.mixerBank = mixerMapping ? mixerMapping.find("MixerBank") : null;
        this.followBank = mixerMapping ? mixerMapping.find("MixerFollowBank") : null;

        this.padSection = root.find("PadSectionElement");
        let padComponent = this.padSection.component;
        padComponent.addNullHandler();
        padComponent.addHandlerForRole(PreSonus.PadSectionRole.kLauncherInput);
        this.launcherHandler = padComponent.getHandler(LaunchkeyMK4Component.kLauncherHandler);
        if (this.launcherHandler)
            this.launcherHandler.setMappingMode(PreSonus.PadSectionLauncherMode.kCellsOnly);
        this.cellRowOffset = 0;
        this.cellColumnOffset = 0;
        this.suspended = false;
        this.updatePadSection();
    }

    paramChanged(param) {
        if (param == this.padModeParam || param == this.padPageParam)
            this.updatePadSection();
        else if (param == this.sceneViewParam)
            this.updateLauncherMappingMode();
        else
            super.paramChanged(param);
    }

    onSuspend(state) {
        this.suspended = state;
        this.updatePadSection();
    }

    //--------------------------------------------------------------------------------------------
    // Launcher pads
    //--------------------------------------------------------------------------------------------

    isLauncherPage() {
        return this.padPageParam.value == LaunchkeyMK4.PadPage.kLauncher;
    }

    updatePadSection() {
        let active = !this.suspended && this.padModeParam.value == LaunchkeyMK4.PadMode.kDAW && this.isLauncherPage();
        this.padSection.component.setActiveHandler(active ? LaunchkeyMK4Component.kLauncherHandler : LaunchkeyMK4Component.kNullHandler);
    }

    updateLauncherMappingMode() {
        let handler = this.launcherHandler;
        if (!handler)
            return;
        if (this.sceneViewParam.value) {
            this.cellRowOffset = handler.getRowOffset();
            this.cellColumnOffset = handler.getColumnOffset();
            handler.setMappingMode(PreSonus.PadSectionLauncherMode.kScenesOnly);
        }
        else {
            handler.setMappingMode(PreSonus.PadSectionLauncherMode.kCellsOnly);
            handler.setRowOffset(this.cellRowOffset);
            handler.setColumnOffset(this.cellColumnOffset);
        }
    }

    onPadUp(state) {
        if (state)
            this.moveLauncher(-1);
    }

    onPadDown(state) {
        if (state)
            this.moveLauncher(1);
    }

    // Up/Down scroll launcher lanes (rows), with Shift the scenes (columns).
    // In scene view the roles are swapped.
    moveLauncher(delta) {
        let handler = this.launcherHandler;
        if (!handler || !this.isLauncherPage())
            return;
        let moveColumns = Boolean(this.sceneViewParam.value) != Boolean(this.shiftParam.value);
        if (moveColumns)
            handler.setColumnOffset(Math.max(0, handler.getColumnOffset() + delta));
        else
            handler.setRowOffset(Math.max(0, handler.getRowOffset() + delta));
    }

    //--------------------------------------------------------------------------------------------
    // Sends
    //--------------------------------------------------------------------------------------------

    onSendPrevious(state) {
        if (state)
            this.stepSendIndex(-1);
    }

    onSendNext(state) {
        if (state)
            this.stepSendIndex(1);
    }

    stepSendIndex(delta) {
        let index = Math.min(Math.max(this.sendIndexParam.value + delta, 0), LaunchkeyMK4.kSendSlotCount - 1);
        if (index != this.sendIndexParam.value)
            this.sendIndexParam.setValue(index, true);
    }

    //--------------------------------------------------------------------------------------------
    // Mixer bank
    //--------------------------------------------------------------------------------------------

    onConnectChannel(index) {
        this.updateTrackPresence(index);
        this.updateBankPosition();
    }

    onPresenceTimer() {
        for (let i = 0; i < this.trackPresentParams.length; i++)
            this.updateTrackPresence(i);
        this.updateBankPosition();
    }

    updateTrackPresence(index) {
        if (!this.mixerBank)
            return;
        let element = this.mixerBank.getElement(index);
        let present = element && element.isConnected() ? 1 : 0;
        let param = this.trackPresentParams[index];
        if (param.value != present)
            param.setValue(present);
    }

    // Position of the faders in the Remote Bank, shown after bank scrolling (as ATOM SQ does it).
    updateBankPosition() {
        if (!this.mixerBank)
            return;
        let first = this.mixerBank.getElement(0);
        let offset = first && first.isConnected() ? this.mixerBank.getBankChildIndex(first) : 0;
        let count = this.mixerBank.getBankChildCount();
        LaunchkeyMK4Component.setInteger(this.bankOffsetParam, offset);
        LaunchkeyMK4Component.setInteger(this.bankCountParam, count);
    }

    static setInteger(param, value) {
        value = Math.min(Math.max(Math.round(Number(value)) || 0, 0), LaunchkeyMK4Component.kMaxBankSize);
        if (param.value != value)
            param.setValue(value);
    }

    // Keep the selected track inside the 8 channel bank.
    onConnectFollowChannel() {
        if (!this.followBank || !this.mixerBank)
            return;
        let element = this.followBank.getElement(0);
        if (!element)
            return;
        let index = this.mixerBank.getBankChildIndex(element);
        if (index < 0)
            return;
        let pageSize = LaunchkeyMK4.kPadsPerRow;
        this.mixerBank.scrollTo(Math.floor(index / pageSize) * pageSize);
    }
}

LaunchkeyMK4Component.kNullHandler = 0;
LaunchkeyMK4Component.kLauncherHandler = 1;
LaunchkeyMK4Component.kMaxBankSize = 9999;

function createLaunchkeyMK4ComponentInstance() {
    return new LaunchkeyMK4Component();
}
