#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError as exc:
    raise SystemExit("Pillow is required to render the PNG terrain review board") from exc


ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
IMAGES = DOCS / "images"
OUT = IMAGES / "terrain-agent-review-board.png"
MANIFEST = DOCS / "terrain-agent-review.json"


CAPTURES = [
    ("panorama_45", "45-degree panorama", "terrain-agent-latest-panorama.png", "terrain-m1-hero-v2-start-elevated.png"),
    ("approach_cut", "Approach terrain cut", "terrain-agent-latest-approach-cut.png", "terrain-m1-hero-v2-first-bend.png"),
    ("inner_basin", "Inner basin", "terrain-agent-latest-inner-basin.png", "terrain-m1-hero-v2-road-edge.png"),
    ("ridge_profile", "Ridge profile", "terrain-agent-latest-ridge-profile.png", "terrain-m1-hero-v2-overlook.png"),
]


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial.ttf",
    ]
    for path in candidates:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size=size)
            except OSError:
                pass
    return ImageFont.load_default()


FONT_TITLE = font(30, True)
FONT_PANEL = font(24, True)
FONT_META = font(15)
FONT_MISSING = font(28, True)


def pick_capture(expected: str, fallback: str) -> tuple[Path, str]:
    expected_path = IMAGES / expected
    if expected_path.exists():
        return expected_path, "latest"
    fallback_path = IMAGES / fallback
    if fallback_path.exists():
        return fallback_path, "fallback"
    return expected_path, "missing"


def cover_image(path: Path, width: int, height: int) -> Image.Image | None:
    if not path.exists():
        return None
    img = Image.open(path).convert("RGB")
    scale = max(width / img.width, height / img.height)
    resized = img.resize((round(img.width * scale), round(img.height * scale)), Image.Resampling.LANCZOS)
    left = max(0, (resized.width - width) // 2)
    top = max(0, (resized.height - height) // 2)
    return resized.crop((left, top, left + width, top + height))


def draw_panel(draw: ImageDraw.ImageDraw, board: Image.Image, x: int, y: int, w: int, h: int, title: str, subtitle: str, path: Path, status: str) -> None:
    draw.rounded_rectangle((x - 2, y - 42, x + w + 2, y + h + 24), radius=10, fill=(16, 23, 26))
    draw.text((x, y - 34), title, font=FONT_PANEL, fill=(247, 251, 240))
    draw.text((x + w - 6, y - 30), subtitle, font=FONT_META, fill=(184, 198, 184), anchor="ra")
    img = cover_image(path, w, h)
    if img is None or status == "missing":
        draw.rectangle((x, y, x + w, y + h), fill=(38, 50, 58))
        draw.text((x + 24, y + h * 0.5 - 14), "missing capture", font=FONT_MISSING, fill=(233, 240, 231))
        draw.text((x + 24, y + h * 0.5 + 24), path.name, font=FONT_META, fill=(174, 188, 176))
        return
    board.paste(img, (x, y))
    draw.rounded_rectangle((x, y, x + w, y + h), radius=4, outline=(28, 39, 43), width=2)


def main() -> None:
    IMAGES.mkdir(parents=True, exist_ok=True)
    manifest = {}
    if MANIFEST.exists():
        manifest = json.loads(MANIFEST.read_text())
    board = Image.new("RGB", (1640, 940), (23, 32, 35))
    draw = ImageDraw.Draw(board)
    draw.text((40, 24), "BlockKart Agent Terrain Review", font=FONT_TITLE, fill=(247, 251, 240))
    draw.text((1600, 32), "actual runner captures only; fallback panels are marked", font=FONT_META, fill=(184, 198, 184), anchor="ra")

    concept_ref = manifest.get("concept") or "docs/images/terrain-upgrade-concept-v1.png"
    concept = ROOT / concept_ref
    draw_panel(draw, board, 40, 92, 760, 475, "Concept target", "reference", concept, "latest" if concept.exists() else "missing")

    panorama_path, panorama_status = pick_capture(CAPTURES[0][2], CAPTURES[0][3])
    draw_panel(draw, board, 840, 92, 760, 475, CAPTURES[0][1], panorama_status, panorama_path, panorama_status)

    approach_path, approach_status = pick_capture(CAPTURES[1][2], CAPTURES[1][3])
    basin_path, basin_status = pick_capture(CAPTURES[2][2], CAPTURES[2][3])
    ridge_path, ridge_status = pick_capture(CAPTURES[3][2], CAPTURES[3][3])
    heightmap = IMAGES / "terrain-heightmap-target-v1.png"

    draw_panel(draw, board, 40, 660, 370, 231, CAPTURES[1][1], approach_status, approach_path, approach_status)
    draw_panel(draw, board, 430, 660, 370, 231, CAPTURES[2][1], basin_status, basin_path, basin_status)
    draw_panel(draw, board, 840, 660, 370, 231, CAPTURES[3][1], ridge_status, ridge_path, ridge_status)
    draw_panel(draw, board, 1230, 660, 370, 231, "Current heightmap", "generated target", heightmap, "latest" if heightmap.exists() else "missing")

    board.save(OUT)

    manifest["boardPng"] = "docs/images/terrain-agent-review-board.png"
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n")
    print(OUT)


if __name__ == "__main__":
    main()
