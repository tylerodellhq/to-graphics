#!/usr/bin/env python3
"""Packs plugin/ into TOGraphics.ccx (a zip with manifest.json at the root) and writes
latest.json for the in-panel update check. Run from this folder: python3 build.py [notes]"""
import json, os, sys, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "plugin")
REPO_RAW = "https://raw.githubusercontent.com/tylerodellhq/to-graphics/main/"

version = json.load(open(os.path.join(SRC, "manifest.json")))["version"]
notes = " ".join(sys.argv[1:]) or "Bug fixes and improvements."
out = os.path.join(HERE, "TOGraphics.ccx")
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk(SRC):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for f in sorted(files):
            if f.startswith(".") or f.endswith(".pyc"):
                continue
            full = os.path.join(root, f)
            z.write(full, os.path.relpath(full, SRC))
json.dump({"version": version, "url": REPO_RAW + "TOGraphics.ccx", "notes": notes},
          open(os.path.join(HERE, "latest.json"), "w"), indent=2)
print(f"TOGraphics.ccx {version} ({os.path.getsize(out)//1024} KB)")
