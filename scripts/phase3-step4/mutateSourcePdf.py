#!/usr/bin/env python3
"""Deterministic source-PDF mutations for the external Phase 1 harness."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import fitz


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def normalized_rect(page: fitz.Page, value: dict[str, float]) -> fitz.Rect:
    return fitz.Rect(
        value["x0"] * page.rect.width,
        value["y0"] * page.rect.height,
        value["x1"] * page.rect.width,
        value["y1"] * page.rect.height,
    )


def render_sha(page: fitz.Page) -> str:
    return sha256(page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False).tobytes("png"))


def text_sha(page: fitz.Page) -> str:
    return sha256(page.get_text("text").encode("utf-8"))


def span_records(page: fitz.Page) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    data = page.get_text("dict", flags=fitz.TEXTFLAGS_TEXT)
    for block in data.get("blocks", []):
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                text = str(span.get("text", ""))
                if not text.strip():
                    continue
                records.append(
                    {
                        "text": text,
                        "bbox": [round(float(v), 6) for v in span["bbox"]],
                        "origin": [round(float(v), 6) for v in span.get("origin", (0, 0))],
                        "font": str(span.get("font", "")),
                        "size": round(float(span.get("size", 0)), 6),
                        "color": int(span.get("color", 0)),
                    }
                )
    return records


def intersects(rect: fitz.Rect, candidates: list[fitz.Rect]) -> bool:
    center = fitz.Point((rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2)
    return any(candidate.contains(center) or not (rect & candidate).is_empty for candidate in candidates)


def source_fonts(document: fitz.Document, page: fitz.Page) -> dict[str, bytes]:
    fonts: dict[str, bytes] = {}
    for font in page.get_fonts(full=True):
        xref = int(font[0])
        names = {str(font[3]), str(font[4])}
        try:
            extracted = document.extract_font(xref)
            content = extracted[3]
        except Exception:
            content = b""
        if not content:
            try:
                content = fitz.Font(str(font[3])).buffer
            except Exception:
                try:
                    content = fitz.Font(str(font[4])).buffer
                except Exception:
                    content = b""
        if not content:
            continue
        for name in names:
            fonts[name] = content
            fonts[name.split("+")[-1]] = content
    return fonts


def rgb_from_int(value: int) -> tuple[float, float, float]:
    return (
        ((value >> 16) & 255) / 255,
        ((value >> 8) & 255) / 255,
        (value & 255) / 255,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    args = parser.parse_args()
    request = json.loads(Path(args.request).read_text(encoding="utf-8"))
    source_path = Path(request["source_path"])
    output_path = Path(request["output_path"])
    result_path = Path(request["result_path"])
    document = fitz.open(source_path)
    source_page_count = document.page_count
    target_page_number = int(request["target_page"])
    target_page = document[target_page_number - 1]
    source_render = render_sha(target_page)
    source_text = text_sha(target_page)
    target_text_before = target_page.get_text("text")
    selected: list[dict[str, object]] = []
    font_fallback_count = 0

    if request["mutation_type"] in {"delete_supporting_span", "remove_row"}:
        rectangles = [normalized_rect(target_page, item) for item in request["rectangles"]]
        source_spans = span_records(target_page)
        selected = [
            span for span in source_spans
            if intersects(fitz.Rect(span["bbox"]), rectangles)
        ]
        if not selected:
            raise RuntimeError("source_span_not_found")
        for rectangle in rectangles:
            target_page.add_redact_annot(rectangle, fill=(1, 1, 1))
        target_page.apply_redactions(images=0, graphics=0, text=0)
        mutated_target_page_number = target_page_number
    elif request["mutation_type"] == "replace_text":
        rectangles = [normalized_rect(target_page, item) for item in request["rectangles"]]
        source_spans = span_records(target_page)
        selected = [
            span for span in source_spans
            if intersects(fitz.Rect(span["bbox"]), rectangles)
        ]
        expected_text = str(request["expected_text"])
        replacement_text = str(request["replacement_text"])
        source_match_mode = str(request.get("source_match_mode", "exact_span"))
        if source_match_mode == "unique_substring_in_single_span":
            exact = [
                span for span in selected
                if str(span["text"]).count(expected_text) == 1
            ]
        elif source_match_mode == "exact_span":
            exact = [
                span for span in selected
                if str(span["text"]).strip() == expected_text.strip()
            ]
        else:
            raise RuntimeError(f"unsupported_source_match_mode:{source_match_mode}")
        if len(exact) != 1:
            raise RuntimeError(
                f"exact_single_native_span_required:expected={expected_text!r}:matches={len(exact)}"
            )
        span = exact[0]
        native_text = str(span["text"])
        if source_match_mode == "unique_substring_in_single_span":
            replacement_native_text = native_text.replace(
                expected_text, replacement_text, 1
            )
        else:
            leading = native_text[: len(native_text) - len(native_text.lstrip())]
            trailing = native_text[len(native_text.rstrip()) :]
            replacement_native_text = f"{leading}{replacement_text}{trailing}"
        font_name = str(span["font"])
        font_bytes = source_fonts(document, target_page).get(font_name)
        base14_aliases = {
            "Helvetica": "helv",
            "Courier": "cour",
            "Times-Roman": "tiro",
        }
        alias = base14_aliases.get(font_name, "replacementfont")
        if not font_bytes and font_name not in base14_aliases:
            raise RuntimeError(f"source_font_bytes_unavailable:{font_name}")
        span_rect = fitz.Rect(span["bbox"])
        target_page.add_redact_annot(span_rect, fill=(1, 1, 1))
        target_page.apply_redactions(images=0, graphics=0, text=0)
        if font_bytes:
            target_page.insert_font(fontname=alias, fontbuffer=font_bytes)
        target_page.insert_text(
            fitz.Point(*span["origin"]),
            replacement_native_text,
            fontsize=max(1, float(span["size"])),
            fontname=alias,
            color=rgb_from_int(int(span["color"])),
            overlay=True,
        )
        mutated_target_page_number = target_page_number
    elif request["mutation_type"] == "cross_page_duplicate_artifact":
        token_rectangles = [
            normalized_rect(target_page, box)
            for cell in request["cells"]
            for box in cell["token_boxes"]
        ]
        selected = [
            span for span in span_records(target_page)
            if intersects(fitz.Rect(span["bbox"]), token_rectangles)
        ]
        if not selected:
            raise RuntimeError("source_span_not_found")
        page_width = target_page.rect.width
        page_height = target_page.rect.height
        fonts = source_fonts(document, target_page)
        new_page = document.new_page(
            width=page_width,
            height=page_height,
        )
        minimum_y = min(float(span["bbox"][1]) for span in selected)
        target_top = page_height * 0.2
        font_aliases: dict[str, str] = {}
        for index, span in enumerate(selected):
            font_name = str(span["font"])
            font_bytes = fonts.get(font_name) or fonts.get(font_name.split("+")[-1])
            alias = font_aliases.get(font_name)
            if alias is None:
                alias = f"srcfont{len(font_aliases)}"
                if font_bytes:
                    new_page.insert_font(fontname=alias, fontbuffer=font_bytes)
                else:
                    alias = "helv"
                    font_fallback_count += 1
                font_aliases[font_name] = alias
            origin = span["origin"]
            x = float(origin[0])
            y = target_top + (float(origin[1]) - minimum_y)
            new_page.insert_text(
                fitz.Point(x, y),
                str(span["text"]),
                fontsize=max(1, float(span["size"])),
                fontname=alias,
                color=rgb_from_int(int(span["color"])),
                overlay=True,
            )
        mutated_target_page_number = document.page_count
    elif request["mutation_type"] == "duplicate_row":
        token_rectangles = [
            normalized_rect(target_page, box)
            for cell in request["cells"]
            for box in cell["token_boxes"]
        ]
        source_span_inventory = span_records(target_page)
        selected = [
            span for span in source_span_inventory
            if intersects(fitz.Rect(span["bbox"]), token_rectangles)
        ]
        if not selected:
            raise RuntimeError("source_span_not_found")
        for span in selected:
            span_rect = fitz.Rect(span["bbox"])
            if not any(candidate.contains(span_rect) for candidate in token_rectangles):
                raise RuntimeError("selected_native_span_crosses_target_token_geometry")
        displacement = float(request["displacement"]) * target_page.rect.height
        destination_rects = [
            fitz.Rect(
                float(span["bbox"][0]),
                float(span["bbox"][1]) + displacement,
                float(span["bbox"][2]),
                float(span["bbox"][3]) + displacement,
            )
            for span in selected
        ]
        if any(rect.y1 > target_page.rect.height for rect in destination_rects):
            raise RuntimeError("inline_duplicate_exceeds_page_bounds")
        unselected = [
            span for span in source_span_inventory if span not in selected
        ]
        if any(
            not (destination & fitz.Rect(span["bbox"])).is_empty
            for destination in destination_rects
            for span in unselected
        ):
            raise RuntimeError("inline_duplicate_overlaps_unrelated_visible_span")
        fonts = source_fonts(document, target_page)
        font_aliases: dict[str, str] = {}
        for span in selected:
            font_name = str(span["font"])
            font_bytes = fonts.get(font_name) or fonts.get(font_name.split("+")[-1])
            if not font_bytes:
                raise RuntimeError(f"source_font_bytes_unavailable:{font_name}")
            alias = font_aliases.get(font_name)
            if alias is None:
                alias = f"inlinefont{len(font_aliases)}"
                target_page.insert_font(fontname=alias, fontbuffer=font_bytes)
                font_aliases[font_name] = alias
            origin = span["origin"]
            target_page.insert_text(
                fitz.Point(float(origin[0]), float(origin[1]) + displacement),
                str(span["text"]),
                fontsize=max(1, float(span["size"])),
                fontname=alias,
                color=rgb_from_int(int(span["color"])),
                overlay=True,
            )
        mutated_target_page_number = target_page_number
    elif request["mutation_type"] == "move_page":
        destination_page = int(request["destination_page"])
        if destination_page < 1 or destination_page > source_page_count:
            raise RuntimeError("destination_page_out_of_bounds")
        document.move_page(target_page_number - 1, destination_page - 1)
        mutated_target_page_number = target_page_number
    else:
        raise RuntimeError(f"unsupported_mutation_type:{request['mutation_type']}")

    document.save(
        output_path,
        garbage=4,
        clean=True,
        deflate=True,
        no_new_id=True,
    )
    document.close()
    mutated = fitz.open(output_path)
    mutated_target = mutated[mutated_target_page_number - 1]
    relocated_target = (
        mutated[int(request["destination_page"]) - 1]
        if request["mutation_type"] == "move_page"
        else None
    )
    result = {
        "capability": {
            "pymupdf_version": fitz.VersionBind,
            "mupdf_version": fitz.mupdf_version,
        },
        "source_page_count": source_page_count,
        "mutated_page_count": mutated.page_count,
        "source_target_render_sha256": source_render,
        "mutated_target_render_sha256": render_sha(mutated_target),
        "source_target_text_sha256": source_text,
        "mutated_target_text_sha256": text_sha(mutated_target),
        "visible_source_changed": source_render != render_sha(mutated_target),
        "selected_span_count": len(selected),
        "selected_spans": selected,
        "target_text_before": target_text_before,
        "target_text_after": mutated_target.get_text("text"),
        "font_fallback_count": font_fallback_count,
        "replacement_text": request.get("replacement_text"),
        "relocated_target_render_sha256":
            render_sha(relocated_target) if relocated_target else None,
        "relocated_target_text_sha256":
            text_sha(relocated_target) if relocated_target else None,
        "destination_page": request.get("destination_page"),
    }
    mutated.close()
    result_path.write_text(json.dumps(result, sort_keys=True, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
