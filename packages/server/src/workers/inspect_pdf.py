"""Raster-level PDF quality checks used after HalfHalf has rendered an export."""
from __future__ import annotations

import argparse
import json

import fitz


def inspect_page(page: fitz.Page, scale: float) -> dict[str, object]:
    pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), colorspace=fitz.csGRAY, alpha=False)
    width, height = pixmap.width, pixmap.height
    pixels = pixmap.samples
    # PDF pages have a white background. Keeping a small tolerance preserves anti-aliased text.
    dark = [(index % width, index // width) for index, value in enumerate(pixels) if value < 238]
    ink_ratio = len(dark) / max(1, width * height)
    if not dark:
        return {"inkRatio": 0, "blank": True, "nearEdge": False, "bounds": None}

    xs = [point[0] for point in dark]
    ys = [point[1] for point in dark]
    left, right, top, bottom = min(xs), max(xs), min(ys), max(ys)
    edge_band = max(3, round(min(width, height) * 0.006))
    return {
        "inkRatio": round(ink_ratio, 5),
        "blank": ink_ratio < 0.00045,
        "nearEdge": left <= edge_band or top <= edge_band or right >= width - edge_band - 1 or bottom >= height - edge_band - 1,
        "bounds": [round(left / width, 4), round(top / height, 4), round((right + 1) / width, 4), round((bottom + 1) / height, 4)],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_pdf")
    parser.add_argument("--scale", type=float, default=0.7)
    args = parser.parse_args()
    document = fitz.open(args.input_pdf)
    try:
        pages = [inspect_page(document.load_page(index), args.scale) for index in range(document.page_count)]
    finally:
        document.close()
    print(json.dumps({"pages": pages}, ensure_ascii=True))


if __name__ == "__main__":
    main()
