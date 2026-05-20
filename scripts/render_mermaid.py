#!/usr/bin/env python3
"""Render every mermaid_code in slides.json to a PNG (cached by content hash).

Usage: render_mermaid.py <talk_dir>
Talk dir must contain slides.json. Diagrams go to <talk_dir>/assets/diagrams.
Mermaid config falls back to talk-builder/assets if not in talk dir.
"""
import json, os, subprocess, sys, hashlib

if len(sys.argv) < 2:
    print("usage: render_mermaid.py <talk_dir>"); sys.exit(1)

TALK = os.path.abspath(sys.argv[1])
ENGINE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SRC  = os.path.join(TALK, "slides.json")
OUT  = os.path.join(TALK, "assets", "diagrams")

def pick(name):
    local = os.path.join(TALK, "assets", name)
    return local if os.path.exists(local) else os.path.join(ENGINE, "assets", name)

CFG = pick("mermaid-config.json")
PUP = pick("puppeteer.json")
os.makedirs(OUT, exist_ok=True)

doc = json.load(open(SRC))
tasks = []
for s in doc["slides"]:
    code = (s.get("data") or {}).get("mermaid_code")
    if not code: continue
    digest = hashlib.sha1(code.encode()).hexdigest()[:12]
    mmd = os.path.join(OUT, f"{digest}.mmd")
    png = os.path.join(OUT, f"{digest}.png")
    s["data"]["mermaid_png"] = png
    if not os.path.exists(png):
        with open(mmd, "w") as f: f.write(code)
        tasks.append((mmd, png, s["data"].get("title","")))

print(f"{len(tasks)} diagrams to render")
for mmd, png, title in tasks:
    print(f"  rendering: {title}")
    r = subprocess.run([
        "npx","--yes","@mermaid-js/mermaid-cli",
        "-i",mmd,"-o",png,"-c",CFG,"-p",PUP,
        "-b","#000000","-w","2400","-H","1400","-s","2"
    ], capture_output=True, text=True)
    if r.returncode != 0:
        print(f"    FAIL: {r.stderr[-300:]}")

json.dump(doc, open(SRC,"w"), ensure_ascii=False, indent=2)
print("Updated slides.json with mermaid_png paths")
