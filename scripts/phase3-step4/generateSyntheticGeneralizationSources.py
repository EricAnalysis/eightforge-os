#!/usr/bin/env python3
"""Generate two deterministic, external-only generic table evaluation sources."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import tempfile
from pathlib import Path

import fitz


ROWS = [
    ("fact-01", "Inspect northern access", "EA", "$11.00", "$22.00"),
    ("fact-02", "Stage portable lighting", "HR", "$13.00", "$39.00"),
    ("fact-03", "Move screened aggregate", "TON", "$17.00", "$68.00"),
    ("fact-04", "Haul reusable barriers", "LOAD", "$19.00", "$95.00"),
    ("fact-05", "Monitor drainage pumps", "DAY", "$23.00", "$138.00"),
    ("fact-06", "Close temporary workspace", "LS", "$29.00", "$29.00"),
]

LAYOUTS = {
    "A": {
        "page": (612, 792),
        "margin": 54,
        "top": 108,
        "row_height": 38,
        "columns": [
            ("description", "Description", 270),
            ("unit", "Unit", 72),
            ("rate", "Rate", 88),
            ("extension", "Extended amount", 110),
        ],
        "pagination": (3, 3),
        "borders": True,
        "subsection_y": 62,
    },
    "B": {
        "page": (720, 540),
        "margin": 78,
        "top": 126,
        "row_height": 31,
        "columns": [
            ("rate", "Unit\nprice", 92),
            ("description", "Work\ndescription", 285),
            ("extension", "Total\namount", 116),
            ("unit", "Unit of\nmeasure", 92),
        ],
        "pagination": (4, 2),
        "borders": False,
        "subsection_y": 82,
    },
}


def canonical(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def ensure_external(directory: Path) -> None:
    root = Path.cwd().resolve()
    target = directory.resolve()
    if target == root or root in target.parents:
        raise RuntimeError("synthetic PDFs and ledgers must remain outside the repository")


def draw_source(label: str, output: Path) -> dict[str, object]:
    layout = LAYOUTS[label]
    spec = {
        "schema": "generic-work-table-v1",
        "layout": label,
        "logical_rows": ROWS,
        "layout_spec": layout,
        "structures": [
            "merged_multiline_cells",
            "subtables",
            "repeated_headers",
            "cross_page_continuation",
        ],
    }
    spec_sha = digest(canonical(spec))
    document = fitz.open()
    observations: list[dict[str, object]] = []
    structural: list[dict[str, object]] = []
    row_offset = 0
    for page_index, count in enumerate(layout["pagination"]):
        width, height = layout["page"]
        page = document.new_page(width=width, height=height)
        margin = layout["margin"]
        subsection_y = layout["subsection_y"] if page_index == 0 else margin
        page.insert_text((margin, subsection_y), "FIELD OPERATIONS\nRESOURCE SCHEDULE",
                         fontsize=9, fontname="helv")
        structural.append({
            "invariant": "merged_multiline_cells",
            "page": page_index + 1,
            "construction_node_id": f"{label}:merged-heading",
            "raw_text": "FIELD OPERATIONS\nRESOURCE SCHEDULE",
            "column_span": 2,
        })
        x_positions = [margin]
        for _, _, column_width in layout["columns"]:
            x_positions.append(x_positions[-1] + column_width)
        top = layout["top"]
        header_height = 34 if label == "B" else 24
        for column_index, (_, header, _) in enumerate(layout["columns"]):
            x0, x1 = x_positions[column_index], x_positions[column_index + 1]
            for line_index, line in enumerate(header.splitlines()):
                page.insert_text((x0 + 4, top + 12 + line_index * 10), line,
                                 fontsize=8, fontname="helv")
            if layout["borders"]:
                page.draw_rect(fitz.Rect(x0, top, x1, top + header_height),
                               color=(0, 0, 0), width=0.6)
        structural.append({
            "invariant": "repeated_headers",
            "page": page_index + 1,
            "construction_node_id": f"{label}:header:{page_index + 1}",
            "roles": [column[0] for column in layout["columns"]],
        })
        for local_row in range(count):
            logical = ROWS[row_offset + local_row]
            values = {
                "description": logical[1],
                "unit": logical[2],
                "rate": logical[3],
                "extension": logical[4],
            }
            y0 = top + header_height + local_row * layout["row_height"]
            for column_index, (role, _, _) in enumerate(layout["columns"]):
                x0, x1 = x_positions[column_index], x_positions[column_index + 1]
                value = values[role]
                page.insert_text((x0 + 4, y0 + 15), value,
                                 fontsize=8.5, fontname="helv")
                if layout["borders"]:
                    page.draw_rect(
                        fitz.Rect(x0, y0, x1, y0 + layout["row_height"]),
                        color=(0, 0, 0), width=0.5,
                    )
                box = page.search_for(value)[-1]
                observations.append({
                    "field_identifier": f"{logical[0]}:{role}",
                    "source_page": page_index + 1,
                    "bbox_x0": box.x0,
                    "bbox_y0": box.y0,
                    "bbox_x1": box.x1,
                    "bbox_y1": box.y1,
                    "page_width_points": width,
                    "page_height_points": height,
                    "exact_raw_text": value,
                    "raw_text_sha256": digest(value.encode()),
                    "interpreted_field_or_role": role,
                    "row_identity": logical[0],
                    "construction_node_id": f"{label}:{logical[0]}:{role}",
                })
        row_offset += count
        if page_index == 0:
            structural.append({
                "invariant": "cross_page_continuation",
                "from_page": 1,
                "to_page": 2,
                "construction_node_id": f"{label}:page-break",
            })
    final_page = document[-1]
    sub_y = layout["top"] + layout["pagination"][-1] * layout["row_height"] + 92
    sub_x = layout["margin"] + (34 if label == "A" else 118)
    final_page.insert_text((sub_x, sub_y), "Checkpoint", fontsize=8, fontname="helv")
    final_page.insert_text((sub_x + 105, sub_y), "Status", fontsize=8, fontname="helv")
    final_page.insert_text((sub_x, sub_y + 24), "North gate", fontsize=8, fontname="helv")
    final_page.insert_text((sub_x + 105, sub_y + 24), "Ready", fontsize=8, fontname="helv")
    structural.append({
        "invariant": "subtables",
        "page": 2,
        "construction_node_id": f"{label}:subtable",
        "parent_schema": "generic-work-table-v1",
        "columns": ["Checkpoint", "Status"],
        "row": ["North gate", "Ready"],
    })
    document.set_metadata({})
    pdf_bytes = document.tobytes(garbage=4, clean=True, deflate=True, no_new_id=True)
    document.close()
    pdf_path = output / f"synthetic-source-{label.lower()}.pdf"
    pdf_path.write_bytes(pdf_bytes)
    source_sha = digest(pdf_bytes)
    for observation in observations:
        observation["source_pdf_sha256"] = source_sha
    ledger = {
        "ledger_version": "synthetic-construction-v1",
        "source_pdf": {
            "sha256": source_sha,
            "byte_length": len(pdf_bytes),
            "pages": 2,
        },
        "construction_spec_sha256": spec_sha,
        "observations": observations,
        "structural_annotations": structural,
    }
    ledger_bytes = json.dumps(ledger, sort_keys=True, indent=2).encode() + b"\n"
    ledger_path = output / f"synthetic-source-{label.lower()}.ledger.json"
    ledger_path.write_bytes(ledger_bytes)
    spec_path = output / f"synthetic-source-{label.lower()}.spec.json"
    spec_path.write_bytes(json.dumps(spec, sort_keys=True, indent=2).encode() + b"\n")
    return {
        "label": label,
        "pdf": str(pdf_path),
        "ledger": str(ledger_path),
        "pdf_sha256": source_sha,
        "ledger_sha256": digest(ledger_bytes),
        "construction_spec_sha256": spec_sha,
    }


def generate(output: Path) -> list[dict[str, object]]:
    output.mkdir(parents=True, exist_ok=True)
    return [draw_source(label, output) for label in ("A", "B")]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--verify-determinism", action="store_true")
    args = parser.parse_args()
    output = Path(args.output_dir)
    ensure_external(output)
    manifest = generate(output)
    if args.verify_determinism:
        replay_root = Path(tempfile.mkdtemp(prefix="eightforge-synthetic-replay-"))
        try:
            replay = generate(replay_root)
            if [
                (item["pdf_sha256"], item["ledger_sha256"]) for item in manifest
            ] != [
                (item["pdf_sha256"], item["ledger_sha256"]) for item in replay
            ]:
                raise RuntimeError("deterministic regeneration mismatch")
        finally:
            shutil.rmtree(replay_root)
    result = {
        "generator_version": "1",
        "pymupdf_version": fitz.VersionBind,
        "mupdf_version": fitz.mupdf_version,
        "deterministic_regeneration": bool(args.verify_determinism),
        "sources": manifest,
    }
    (output / "synthetic-generation-manifest.json").write_bytes(
        json.dumps(result, sort_keys=True, indent=2).encode() + b"\n"
    )
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
