"""Rebuild the app icons from icon.svg and icon-small.svg.

Run from anywhere: python src-tauri/icons/source/build_icons.py
Sizes up to 40px come from icon-small.svg (drawn for tiny sizes), larger
ones from icon.svg. Rendering is done by `tauri icon`, which rasterises SVG.
"""

import os
import shutil
import subprocess
import tempfile

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ICONS = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(ICONS))

SMALL_SIZES = [16, 20, 24, 32, 40]
LARGE_SIZES = [48, 64, 128, 256, 512]


def render(svg, sizes, out_dir):
    args = ["npx", "tauri", "icon", os.path.join(HERE, svg), "-o", out_dir]
    for size in sizes:
        args += ["-p", str(size)]
    subprocess.run(args, cwd=ROOT, check=True, shell=os.name == "nt", capture_output=True)
    return {s: Image.open(os.path.join(out_dir, f"{s}x{s}.png")).convert("RGBA") for s in sizes}


def main():
    with tempfile.TemporaryDirectory() as tmp:
        small = render("icon-small.svg", SMALL_SIZES, os.path.join(tmp, "small"))
        large = render("icon.svg", LARGE_SIZES, os.path.join(tmp, "large"))

        frames = {**small, **large}
        ico_sizes = [16, 20, 24, 32, 40, 48, 64, 256]
        base = frames[256]
        base.save(
            os.path.join(ICONS, "icon.ico"),
            format="ICO",
            sizes=[(s, s) for s in ico_sizes],
            append_images=[frames[s] for s in ico_sizes if s != 256],
        )

        small[32].save(os.path.join(ICONS, "32x32.png"))
        large[128].save(os.path.join(ICONS, "128x128.png"))
        large[256].save(os.path.join(ICONS, "128x128@2x.png"))
        large[512].save(os.path.join(ICONS, "icon.png"))

    print("icons written to", ICONS)


if __name__ == "__main__":
    main()
