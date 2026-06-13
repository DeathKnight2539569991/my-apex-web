from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.engine import OcrOptions, recognize_image_bytes


def main() -> int:
    parser = argparse.ArgumentParser(description="Recognize one Apex screenshot with PaddleOCR.")
    parser.add_argument("image", type=Path, help="Image path to recognize.")
    parser.add_argument("--crop-mode", choices=["stats-panel", "none"], default="stats-panel")
    parser.add_argument("--preprocess", choices=["none", "binarize"], default="none")
    parser.add_argument("--no-upscale", action="store_true", help="Disable automatic small-image upscaling.")
    parser.add_argument("--json", action="store_true", help="Print the full JSON response.")
    args = parser.parse_args()

    if not args.image.exists():
        parser.error(f"Image does not exist: {args.image}")

    result = recognize_image_bytes(
        args.image.read_bytes(),
        OcrOptions(crop_mode=args.crop_mode, preprocess=args.preprocess, upscale=not args.no_upscale),
    )

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    print("=== OCR Text ===")
    print(result["text"] or "(empty)")
    print()
    print(f"confidence: {result['confidence']}")
    print(f"elapsedMs: {result['elapsedMs']}")
    print(f"lines: {len(result['lines'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

