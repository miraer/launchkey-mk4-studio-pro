# Novation Launchkey MK4 for Fender Studio Pro

Unofficial control surface integration for the **Novation Launchkey MK4** (25 / 37 / 49 / 61)
in **Fender Studio Pro** (formerly PreSonus Studio One): transport, mixer faders, Control Link
encoders, clip launcher pads and the keyboard's screen — including track names in Cyrillic,
which the Launchkey's built-in font cannot show.

[Русская версия](README.ru.md)

<p>
<img src="docs/screen-track.png" width="32%" alt="Main screen: selected track and encoder mode">
<img src="docs/screen-fader.png" width="32%" alt="Fader pop-up with parameter value">
<img src="docs/screen-channels.png" width="32%" alt="Channels on the faders after bank change">
</p>

*Screens as drawn by the script: main screen, fader pop-up, channels on the faders.*

## Features

- **Transport**: Play, Stop, Record, Loop, Metronome, Capture MIDI, Quantise, Undo, with Shift
  functions. Button LEDs follow Studio Pro.
- **Faders** (49 / 61): volume of 8 channels and Main. The buttons under the faders select or
  arm tracks and light up in the track colours.
- **Encoders** in all DAW modes of the Launchkey: Plugin (Control Link of the focused plugin),
  Mixer (volume / pan), Sends, Transport (position, zoom, loop, markers, tracks, arranger sections, tempo).
- **Pads**: clip launcher (2 lanes × 8 scenes, or 16 scenes) or a Mute / Solo page.
- **Screen**: selected track, encoder mode, parameter names and values, the channels on the
  faders after scrolling the bank. Texts with Cyrillic letters are drawn by the script.
- Keys and pads in Drum mode keep working through the regular MIDI port.

## Requirements

- Fender Studio Pro 8 (tested: 8.1.2 on Windows 11). Studio One 6 / 7 have a similar scripting
  system, the integration may work there, but this is not tested.
- Novation Launchkey MK4 25, 37, 49 or 61 (tested: 49). The Launchkey **Mini** MK4 is not
  supported (different protocol header and controls).
- macOS: the port names are included, but the integration has only been tested on Windows.

## Installation

1. Download `launchkey-mk4-studio-pro-*.zip` from
   [Releases](https://github.com/miraer/launchkey-mk4-studio-pro/releases) and unpack it.
2. Copy the folder `Novation Launchkey MK4` to
   - Windows: `%APPDATA%\Fender\Studio Pro 8\User Devices\`
   - macOS: `~/Library/Application Support/Fender/Studio Pro 8/User Devices/` (not tested)

   Create the `User Devices` folder if it does not exist.
3. Restart Studio Pro.
4. **Options → External Devices → Add… → Novation → Launchkey MK4 DAW** (Preferences on macOS),
   then select the Launchkey's DAW ports (the second USB MIDI interface), e.g. for the 49:

   | | Windows | macOS |
   |---|---|---|
   | Receive From | `MIDIIN2 (Launchkey MK4 49 MIDI)` | `Launchkey MK4 49 DAW Out` |
   | Send To | `MIDIOUT2 (Launchkey MK4 49 MIDI` | `Launchkey MK4 49 DAW In` |

   Windows cuts port names to 31 characters, hence the missing parenthesis.
5. Keep the regular keyboard device on the port `Launchkey MK4 49 MIDI` as it is: it plays
   notes, drum pads, pitch bend and modulation. If Studio Pro has a generic HUI or Mackie
   Control device on the DAW ports, remove it.

## Controls

| Control | Action | With Shift |
|---|---|---|
| Play / Stop | Start / pause, stop | Play from loop start / return to zero |
| Record / Loop | Record, loop on / off | Autopunch / loop selection |
| Metronome | Click on / off | Precount |
| Capture MIDI | Retrospective recording | — |
| Quantise / Undo | Quantize, undo | Quantize 50 % / redo |
| Track ‹ › | Previous / next track | Fader bank 8 channels left / right |
| Faders 1–8, 9 | Volume of the 8 bank channels, Main | |
| Fader buttons | Select (track colour) or arm (red) | |
| Arm / Select | Switch the fader button mode | |

**Encoders** — the mode is selected on the Launchkey (Shift + pads):

| Mode | Encoders | ▲ / ▼ next to the encoders |
|---|---|---|
| Plugin | Control Link of the focused plugin | Control Link pages; with Shift previous / next plugin in the rack |
| Mixer | Volume or pan of 8 channels | ▲ volume, ▼ pan |
| Sends | Level of send N of 8 channels | Send 1–8 |
| Transport | Bar ±, zoom horizontal / vertical, move loop, markers, tracks, arranger sections, tempo | ▲ inserts a marker |

**Pads** (DAW pad mode):

| Button | Launcher page | Mute / Solo page |
|---|---|---|
| Pads | Launcher clips (2 lanes × 8 scenes) | Top row mute, bottom row solo |
| ▲ / ▼ left of the pads | Launcher lanes (with Shift: scenes) | Channel bank |
| Scene Launch | Press: scene view (16 scenes), hold: temporarily | — |
| Shift + Scene Launch | Launcher: stop all | — |
| Function | Launcher ↔ Mute / Solo | |
| Shift + Function | Show / hide the Launcher | |

The 25 and 37 have no faders and only Play and Record as transport buttons; Track ‹ › are
Shift + the pad arrows there, as printed on the panel.

## Which channels are on the faders

Faders 1–8 (and the encoders in Mixer and Sends mode, and the Mute / Solo pads) follow the
**Remote Bank** of Studio Pro, in console order: Console (F3) → **Channel List** in the left
column → **Remote** → show or hide channels with the round buttons → **Remote** again. Hidden
channels are skipped; move channels in the console to change their fader. Shift + Track ‹ ›
scrolls by 8 channels, and the bank follows the selected track. Fader 9 is always Main.

After scrolling, the screen shows the channels now on the faders ("Channels 9-16 / 20" and the
numbered channel names). While Shift is held the Launchkey shows its own mode screen
(e.g. "Transport / Drum"), so the list appears when Shift is released.

## Screen and Cyrillic

The Launchkey's font only has ASCII characters. Screens containing Cyrillic letters (track,
channel and plugin names) are drawn by the script and sent as 128 × 64 pictures: the main
screen, fader / encoder pop-ups and notifications. The channel list after bank scrolling is
always a picture, as the Launchkey's own 8 name display cuts names to about 4 letters.
Pop-up values update up to about 10 times per second, the fastest rate the Launchkey accepts
pictures. Latin-only texts use the Launchkey's own font. If the keyboard does not confirm the
pictures, the script falls back to transliterated text.

## Settings

`LaunchkeyMK4MidiDevice.js`, `kLaunchkeyMK4FaderPickup`:
- `false` (default): the faders always send their physical position.
- `true`: the Launchkey's pickup mode, a fader only takes over once it reaches the DAW value.

Restart Studio Pro after changing the scripts.

## Troubleshooting

- Script errors are written to `%APPDATA%\Fender\Studio Pro 8\Studio Pro.log`.
- The device is missing under Add…: check the folder location and restart Studio Pro.
- Faders or encoders do nothing: check that Receive From / Send To are the DAW ports
  (`MIDIIN2` / `MIDIOUT2`), not the keyboard port.

Bug reports and pull requests are welcome; please mention the Launchkey model, the operating
system and the Studio Pro version.

## Development

The scripts use Studio Pro's JavaScript control surface API (`JSControlSurfaceDevice`):
`LaunchkeyMK4MidiDevice.js` handles MIDI and the screen, `LaunchkeyMK4Component.js` the host
side, `Launchkey MK4 DAW.surface.xml` maps the controls. Tests and generators are in
[tools](tools/README.md).

## Credits and license

[MIT](LICENSE).

- Protocol: Novation Launchkey MK4 Programmer's Reference Guide v3.0, checked on hardware.
  The open source Launchkey MK4 integrations of Bitwig and Zynthian helped to cross-check it.
- Colour palette: sampled from the colour table of the Programmer's Reference Guide
  (`tools/gen_palette.py`).
- Screen fonts: X.Org misc-fixed (public domain), see `LaunchkeyMK4Font.js`.

Novation, Launchkey, Fender, Studio Pro and Studio One are trademarks of their respective owners.
This project is not affiliated with or endorsed by Focusrite / Novation or Fender / PreSonus.
