#!/usr/bin/env bash
# Build any talk from a slides.json.
# Usage:
#   build.sh <talk_dir>          # render mermaid + build pptx
#   build.sh <talk_dir> quick    # skip mermaid (just rebuild pptx)
set -euo pipefail

if [ $# -lt 1 ]; then
    echo "usage: build.sh <talk_dir> [quick]"
    echo "  talk_dir must contain slides.json"
    exit 1
fi

TALK="$(cd "$1" && pwd)"
MODE="${2:-full}"
ENGINE="$(cd "$(dirname "$0")" && pwd)"

if [ ! -f "$TALK/slides.json" ]; then
    echo "ERROR: $TALK/slides.json not found"
    exit 1
fi

mkdir -p "$TALK/output" "$TALK/assets/diagrams"

if [ "$MODE" != "quick" ]; then
    echo "==> Rendering mermaid diagrams"
    python3 "$ENGINE/scripts/render_mermaid.py" "$TALK"
fi

echo "==> Building pptx"
python3 "$ENGINE/scripts/build_pptx.py" "$TALK"

# Descobre o arquivo gerado (build_pptx nomeia pelo título da presentation)
PPTX="$(ls -t "$TALK/output/"*.pptx 2>/dev/null | head -1)"
NOTES="${PPTX%.pptx}.notes.md"

# Write speaker notes to markdown (Keynote rejects embedded notes XML)
python3 - "$TALK" "$NOTES" <<'PY'
import json, os, sys
talk, notes_path = sys.argv[1], sys.argv[2]
doc = json.load(open(os.path.join(talk, "slides.json")))
out = []
for i, s in enumerate(doc["slides"], 1):
    notes = (s.get("data") or {}).get("notes") or s.get("notes")
    if not notes: continue
    title = (s.get("data") or {}).get("title", s.get("template", ""))
    out.append(f"## Slide {i}: {title}\n\n{notes}\n")
open(notes_path, "w").write("\n".join(out))
print(f"notes written: {notes_path}")
PY

xattr -c "$PPTX" 2>/dev/null || true
echo "✓ Done → $PPTX"
