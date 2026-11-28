#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""同步静态产物到 docs/（保留既有 docs/net/ 地理数据并更新 index.html / src/ / timeline.json）。"""

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"

def main():
    subprocess.run([sys.executable, "-X", "utf8", str(ROOT / "tools/generate_timeline.py")], check=True)
    for rel in ("index.html", "src/viewer_core.js", "src/viewer.js"):
        src = ROOT / rel
        dst = DOCS / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        print(f"synced {rel} -> docs/{rel} ({dst.stat().st_size:,} B)")
    # 确保所有静态资源存在
    for required in (
        "net/lines.geojson",
        "net/stops.geojson",
        "net/index.json",
        "net/timeline.json",
        "assets/vendor/maplibre-gl.js",
        "basemap/provinces-wgs84.json",
        "basemap/districts-wgs84.json",
    ):
        p = DOCS / required
        if not p.is_file():
            raise SystemExit(f"Missing required deploy asset: {p}")
    print("docs/ deployment bundle verified OK")

if __name__ == "__main__":
    main()
