#!/usr/bin/env python3
"""Generate Mac, website and iOS icons from the existing Android launcher artwork."""
from pathlib import Path
import subprocess
import tempfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
RES = ROOT / "android/app/src/main/res"
ANDROID = "{http://schemas.android.com/apk/res/android}"
colors = {item.attrib["name"]: item.text for item in ET.parse(RES / "values/colors.xml").getroot().findall("color")}
vector = ET.parse(RES / "drawable/ic_launcher_foreground.xml").getroot()
assert vector.attrib[ANDROID + "viewportWidth"] == "108"
assert vector.attrib[ANDROID + "viewportHeight"] == "108"
group = vector.find("group")
assert group is not None and len(vector) == 1
px, py, sx, sy = (group.attrib[ANDROID + key] for key in ("pivotX", "pivotY", "scaleX", "scaleY"))
art = ET.Element("g", {"transform": f"translate({px} {py}) scale({sx} {sy}) translate(-{px} -{py})"})
for path in group:
    assert path.tag == "path" and set(path.attrib) == {ANDROID + key for key in ("fillColor", "fillType", "pathData")}
    color = path.attrib[ANDROID + "fillColor"]
    assert color.startswith("@color/")
    assert path.attrib[ANDROID + "fillType"] == "evenOdd"
    ET.SubElement(art, "path", {"fill": colors[color[7:]], "fill-rule": "evenodd", "d": path.attrib[ANDROID + "pathData"]})
artwork = ET.tostring(art, encoding="unicode")
background = colors["brand_icon_background"]

def svg(mac):
    surface = f'<rect x="9.7" y="9.7" width="88.6" height="88.6" rx="20.25" fill="{background}"/>' if mac else f'<rect width="108" height="108" fill="{background}"/>'
    mark = f'<g transform="translate(9.7 9.7) scale({88.6 / 108})">{artwork}</g>' if mac else artwork
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 108 108"><title>TermBridge</title>\n<!-- Generated from Android launcher artwork by scripts/sync-app-icons.py. -->\n{surface}\n{mark}\n</svg>\n'

mac_svg = svg(True)
(ROOT / "macos/TermBridgeControlCenter/Resources/AppIcon.svg").write_text(mac_svg)
(ROOT / "cloudflare/downloads-site/public/favicon.svg").write_text(mac_svg)
ios_svg = ROOT / "ios/AppIcon.svg"
ios_svg.write_text(svg(False))
with tempfile.TemporaryDirectory(prefix="termbridge-icons-") as work:
    master = Path(work) / "master.png"
    subprocess.run(["sips", "-s", "format", "png", str(ios_svg), "--out", str(master)], check=True, stdout=subprocess.DEVNULL)
    # iOS distribution icons must have no alpha channel, including fully opaque alpha.
    subprocess.run(["swift", "-e", '''
import Foundation
import CoreGraphics
import ImageIO
let url = URL(fileURLWithPath: CommandLine.arguments[1])
let source = CGImageSourceCreateWithURL(url as CFURL, nil)!
let image = CGImageSourceCreateImageAtIndex(source, 0, nil)!
let context = CGContext(data: nil, width: 1024, height: 1024, bitsPerComponent: 8,
    bytesPerRow: 4096, space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
context.draw(image, in: CGRect(x: 0, y: 0, width: 1024, height: 1024))
let destination = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil)!
CGImageDestinationAddImage(destination, context.makeImage()!, nil)
precondition(CGImageDestinationFinalize(destination))
''', str(master)], check=True)
    for target in (ROOT / "ios/Termbridge/Resources").glob("AppIcon*.png"):
        stem = target.stem.removeprefix("AppIcon")
        size, _, scale = stem.partition("@")
        pixels = round(float(size) * (float(scale.removesuffix("x")) if scale else 1))
        subprocess.run(["sips", "-z", str(pixels), str(pixels), str(master), "--out", str(target)], check=True, stdout=subprocess.DEVNULL)
print("Mac, website and iOS icons generated from Android launcher paths and colors.")
