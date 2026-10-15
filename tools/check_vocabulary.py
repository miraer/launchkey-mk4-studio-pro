"""Checks that our surface XML only uses vocabulary that appears in Studio Pro's shipped surface files."""
import collections
import glob
import os
import re
import sys
import xml.etree.ElementTree as ET

ROOT = r"C:\Program Files\Fender\Studio Pro 8\devices"
OURS = sys.argv[1]
TOKEN_ATTRS = {"options"}
VALUE_ATTRS = {("Control", "type"), ("MidiMessage", "status"), ("ScrollButton", "direction"),
               ("ScrollButton", "direction2"), ("Bank", "target"), ("ScrollBank", "target"),
               ("PlacementBank", "target"), ("using", "device"), ("DeviceMapping", "device"),
               ("ParamVariant", "strict"), ("PadSection", "roles"), ("ParamVariant", "using")}


def load(path):
    text = open(path, encoding="utf-8", errors="replace").read()
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    return ET.fromstring(text.encode("utf-8"))


def walk(el, ctx, out):
    for child in el:
        tag = child.tag
        new_ctx = ctx
        if tag == "DeviceMapping":
            new_ctx = ctx + ["DM:" + child.get("device", "")]
        elif tag in ("Bank", "ScrollBank", "PlacementBank"):
            new_ctx = ctx + ["B:" + child.get("target", "")]
        elif tag == "using":
            new_ctx = ctx + ["U:" + child.get("device", "").replace("device:///", "")]
        elif tag == "GenericMapping":
            new_ctx = ctx + ["Generic"]
        out.append((tag, dict(child.attrib), new_ctx))
        walk(child, new_ctx, out)


def param_context(ctx, attrib=None):
    if attrib and attrib.get("using") == "@global":
        return "@global"
    # innermost using/bank/device mapping decides which host object owns the parameter
    for item in reversed(ctx):
        if item.startswith(("U:", "B:", "DM:")) or item == "Generic":
            if item == "U:@global":
                return "@global"
            return item
    return "@global"


shipped_pairs, shipped_values, shipped_tokens = set(), collections.defaultdict(set), collections.defaultdict(set)
shipped_params = collections.defaultdict(set)
for path in glob.glob(ROOT + r"\**\*.surface.xml", recursive=True):
    items = []
    walk(load(path), [], items)
    for tag, attrib, ctx in items:
        for key, value in attrib.items():
            shipped_pairs.add((tag, key))
            if (tag, key) in VALUE_ATTRS:
                shipped_values[(tag, key)].add(value)
            if key in TOKEN_ATTRS:
                shipped_tokens[tag].update(value.split())
        if "param" in attrib and "$" not in attrib["param"]:
            shipped_params[param_context(ctx, attrib)].add(attrib["param"])

CHANNEL_CONTEXTS = {"B:RemoteBank", "B:RemoteAllBank", "B:AllBank", "B:FollowBank", "B:MasterBank"}
KNOWN_FROM_SDK_AND_JS = set()
dll = open(r"C:\Program Files\Fender\Studio Pro 8\Plugins\musicdevices.dll", "rb").read().decode("latin-1")
KNOWN_FROM_SDK_AND_JS.update(re.findall(r'ParamID\["k\w+"\] = "([^"]+)"', dll))
for js in glob.glob(ROOT + r"\**\*.js", recursive=True):
    KNOWN_FROM_SDK_AND_JS.update(re.findall(r'"([A-Za-z][\w/]*)"', open(js, encoding="utf-8", errors="replace").read()))
notes = []
problems = []
ours = []
walk(load(OURS), [], ours)
for tag, attrib, ctx in ours:
    for key, value in attrib.items():
        if (tag, key) not in shipped_pairs:
            problems.append(f"attribute never used in shipped files: <{tag} {key}=...>")
        if (tag, key) in VALUE_ATTRS and "$" not in value and value not in shipped_values[(tag, key)]:
            problems.append(f"value never used in shipped files: <{tag} {key}='{value}'>")
        if key in TOKEN_ATTRS:
            for token in value.split():
                if token not in shipped_tokens[tag]:
                    problems.append(f"option token never used in shipped files: <{tag} options='{token}'>")
    if "param" in attrib:
        context = param_context(ctx, attrib)
        name = attrib["param"]
        if context == "@global" or name in shipped_params[context]:
            continue
        if any(name in shipped_params[c] for c in CHANNEL_CONTEXTS) and context in CHANNEL_CONTEXTS:
            notes.append(f"param '{name}' in {context}: shipped surfaces use it on channels of another bank")
        elif name in KNOWN_FROM_SDK_AND_JS:
            notes.append(f"param '{name}' in {context}: known from SDK ParamID / shipped JS")
        else:
            problems.append(f"param '{name}' never used in context {context} in shipped files")

print(f"checked {len(ours)} elements against {len(shipped_pairs)} shipped tag/attribute pairs")
for context in sorted({param_context(c, a) for _, a, c in ours if 'param' in a}):
    used = sorted({a['param'] for _, a, c in ours if 'param' in a and param_context(c, a) == context})
    print(f"  params in {context}: {used}")
for n in sorted(set(notes)):
    print("  note:", n)
if problems:
    print("PROBLEMS:")
    print("\n".join(sorted(set(problems))))
    sys.exit(1)
print("OK: vocabulary fully covered by shipped surfaces")
