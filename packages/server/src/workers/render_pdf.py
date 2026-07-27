from __future__ import annotations

import argparse
import json
from pathlib import Path

import fitz


def normalized_clip(page: fitz.Page, bbox: list[float] | None) -> fitz.Rect | None:
    if not bbox:
        return None
    x0, y0, x1, y1 = bbox
    rect = page.rect
    pad_x = rect.width * 0.008
    pad_y = rect.height * 0.008
    clip = fitz.Rect(
        rect.x0 + rect.width * x0 - pad_x,
        rect.y0 + rect.height * y0 - pad_y,
        rect.x0 + rect.width * x1 + pad_x,
        rect.y0 + rect.height * y1 + pad_y,
    )
    return clip & rect


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_pdf")
    parser.add_argument("output_dir")
    parser.add_argument("--requests", required=True)
    parser.add_argument("--scale", type=float, default=1.35)
    parser.add_argument("--quality", type=int, default=72)
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    requests = json.loads(Path(args.requests).read_text(encoding="utf-8"))
    document = fitz.open(args.input_pdf)
    results: list[dict[str, object]] = []

    try:
        matrix = fitz.Matrix(args.scale, args.scale)
        for request in requests:
            page_number = int(request["page"])
            if page_number < 1 or page_number > document.page_count:
                raise ValueError(f"page out of range: {page_number}")
            page = document.load_page(page_number - 1)
            clip = normalized_clip(page, request.get("bbox"))
            pixmap = page.get_pixmap(matrix=matrix, clip=clip, alpha=False)
            asset_id = str(request["id"])
            output_path = output_dir / f"{asset_id}.jpg"
            pixmap.save(str(output_path), jpg_quality=args.quality)
            results.append(
                {
                    "id": asset_id,
                    "page": page_number,
                    "bbox": request.get("bbox"),
                    "path": str(output_path),
                    "width": pixmap.width,
                    "height": pixmap.height,
                    "sizeBytes": output_path.stat().st_size,
                    "mimeType": "image/jpeg",
                }
            )
    finally:
        document.close()

    print(json.dumps({"assets": results}, ensure_ascii=True))


if __name__ == "__main__":
    main()
