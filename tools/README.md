# Tools

Development tools for the Launchkey MK4 scripts. Python 3, Windows with Fender Studio Pro 8
installed (the tests read Studio Pro's script SDK from its installation, nothing of it is part
of this repository).

```
pip install mini-racer pillow pypdfium2
```

| Tool | Purpose |
|---|---|
| `test_all.py` | Regression and fuzz tests of the scripts in V8 with a mocked Studio Pro host: MIDI and SysEx output, LEDs, screen pictures and their pacing, bank overview, component logic. `python tools/test_all.py "Novation Launchkey MK4"` |
| `check_vocabulary.py` | Checks that the surface XML only uses tags, attributes and options found in the surface files shipped with Studio Pro. `python tools/check_vocabulary.py "Novation Launchkey MK4/Launchkey MK4 DAW.surface.xml"` |
| `render_screens.py` | Renders `docs/screen-*.png` with the script's own screen renderer. |
| `gen_font.py` | Generates `LaunchkeyMK4Font.js` from the X.Org font-misc-misc 1.1.3 BDF fonts (public domain), see the link in the file. |
| `gen_palette.py` | Generates the colour palette in `LaunchkeyMK4Protocol.js` from the colour table of Novation's Launchkey MK4 Programmer's Reference Guide (PDF, download from Novation). `python tools/gen_palette.py guide.pdf --write "Novation Launchkey MK4/LaunchkeyMK4Protocol.js"` |
