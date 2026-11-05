#!/usr/bin/env python3
"""SYNTHETIC FDE PILOT PACKAGE GENERATOR. Standard library only; byte-for-byte deterministic.

Every person, organization, place, contract, rate, and ticket here is fictional.
This single data source writes the customer documents and the evaluator's arithmetic, so the
two cannot drift. It does not read or call EightForge.

Usage: python generate_package.py
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import textwrap
import zipfile
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent
INITIAL = ROOT / "customer" / "documents" / "initial"
LATER = ROOT / "customer" / "documents" / "later"
NEGATIVE = ROOT / "operator" / "negative-test-files"
EVALUATOR = ROOT / "evaluator"
BANNER = "SYNTHETIC TEST DOCUMENT - FICTIONAL - NOT A REAL CONTRACT OR RECORD"
ZIP_TIME = (2026, 1, 1, 0, 0, 0)

# ---------------------------------------------------------------- fictional source data
CUSTOMER = "Southeastern Recovery Services, LLC"
OWNER = "Merrow County Emergency Management Agency"
EVENT = "Tropical Storm Alder"
MSA_ID = "MSA-SRS-2026-014"
SCHEDULE_ID = "PS-A-2026-014"
AMD1_ID = "AMD-01-MSA-SRS-2026-014"
AMD2_ID = "AMD-02-MSA-SRS-2026-014"
SOP_ID = "SRS-OPS-SOP-07"
REGISTER_ID = "SRS-TCR-2026"
BASE_DATE = "2026-03-01"
AMD1_DATE = "2026-06-15"
AMD2_DATE = "2026-08-01"

# (item code, description, unit, rate or None, note)
SCHEDULE = [
    ("V-1", "Vegetative debris haul, 0-15 one-way miles", "CY", "8.40", ""),
    ("V-2", "Vegetative debris haul, 16-30 one-way miles", "CY", "10.25", ""),
    ("V-3", "Vegetative debris haul, 31 or more one-way miles", "CY", "12.60", ""),
    ("C-1", "Construction and demolition debris haul, 0-15 one-way miles", "CY", "9.75", ""),
    ("C-2", "Construction and demolition debris haul, 16-30 one-way miles", "CY", "11.90", ""),
    ("C-3", "Construction and demolition debris haul, 31 or more one-way miles", "CY", None, "Rate to be determined by written agreement"),
    ("R-1", "Vegetative debris reduction by grinding", "CY", "2.85", ""),
    ("R-2", "Reduced debris final haul", "CY", "3.40", ""),
    ("S-1", "Stump removal, 24 to 36 inch diameter", "EA", "110.00", ""),
    ("S-2", "Stump removal, 37 to 48 inch diameter", "EA", "165.00", ""),
    ("S-3", "Stump removal, over 48 inch diameter", "EA", None, "Rate to be negotiated before work starts"),
    ("H-1", "Hazardous limb removal, per tree", "EA", "85.00", ""),
    ("H-2", "Hazardous tree removal, 6 to 12 inch diameter", "EA", "95.00", ""),
    ("T-1", "Disposal site tipping fee", "TON", None, "Pass-through at documented cost with no markup"),
]
RATE_HISTORY = {  # item -> [(effective date, rate, source)], applied by service date
    "V-1": [(BASE_DATE, "8.40", SCHEDULE_ID)],
    "V-2": [(BASE_DATE, "10.25", SCHEDULE_ID), (AMD1_DATE, "10.90", AMD1_ID), (AMD2_DATE, "11.35", AMD2_ID)],
    "V-3": [(BASE_DATE, "12.60", SCHEDULE_ID)],
    "C-1": [(BASE_DATE, "9.75", SCHEDULE_ID)],
    "C-2": [(BASE_DATE, "11.90", SCHEDULE_ID)],
}
# ticket, date, truck, debris, load call %, certified CY, one-way miles, site, monitor initials, note
TICKETS = [
    ("T-100201", "2026-06-10", "TRK-11", "Vegetative", 80, 60, 12, "Bellweather TDSR", "KO", ""),
    ("T-100202", "2026-06-10", "TRK-14", "Vegetative", 75, 72, 22, "Bellweather TDSR", "KO", ""),
    ("T-100203", "2026-06-12", "TRK-11", "C&D", 90, 60, 9, "Sable Creek Landfill", "RM", ""),
    ("T-100204", "2026-06-14", "TRK-19", "Vegetative", 65, 85, 18, "Bellweather TDSR", "KO", ""),
    ("T-100205", "2026-06-15", "TRK-14", "Vegetative", 85, 72, 24, "Bellweather TDSR", "KO", ""),
    ("T-100206", "2026-06-16", "TRK-22", "Vegetative", 70, 66, 27, "Bellweather TDSR", "RM", ""),
    ("T-100206", "2026-06-16", "TRK-22", "Vegetative", 70, 66, 27, "Bellweather TDSR", "RM", "Entered twice at the scale house"),
    ("T-100208", "2026-06-18", "TRK-11", "C&D", 95, 60, 17, "Sable Creek Landfill", "RM", ""),
    ("T-100209", "2026-06-19", "TRK-31", "Vegetative", 80, 78, 14, "Bellweather TDSR", "KO", ""),
    ("T-100210", "2026-06-20", "TRK-14", "C&D", 45, 72, 11, "Sable Creek Landfill", "RM", "Light load, monitor flagged"),
    ("T-100211", "2026-06-21", "TRK-19", "Mixed", 70, 85, 13, "Sable Creek Landfill", "KO", "Vegetative and C&D together"),
    ("T-100212", "2026-06-22", "TRK-22", "Vegetative", 75, 66, 33, "Bellweather TDSR", "RM", ""),
    ("T-100213", "2026-06-23", "TRK-11", "Vegetative", 80, 60, 10, "Bellweather TDSR", "", "Monitor initials missing"),
    ("T-100214", "2026-06-24", "TRK-14", "C&D", 80, 72, 15, "Sable Creek Landfill", "RM", ""),
    ("T-100214", "2026-06-24", "TRK-14", "C&D", 85, 72, 15, "Sable Creek Landfill", "RM", "Second entry shows a different load call"),
    ("T-100215", "2026-08-03", "TRK-19", "Vegetative", 85, 85, 20, "Bellweather TDSR", "KO", ""),
    ("T-100216", "2026-06-25", "TRK-11", "C&D", 90, 60, 31, "Sable Creek Landfill", "RM", "Long haul"),
]


def item_for(debris: str, miles: int) -> str | None:
    band = 1 if miles <= 15 else 2 if miles <= 30 else 3
    return {"Vegetative": f"V-{band}", "C&D": f"C-{band}"}.get(debris)


def rate_on(item: str | None, service_date: str, include_amd2: bool) -> tuple[str | None, str | None]:
    if item is None or item not in RATE_HISTORY:
        return None, None
    chosen = (None, None)
    for effective, rate, source in RATE_HISTORY[item]:
        if source == AMD2_ID and not include_amd2:
            continue
        if service_date >= effective:
            chosen = (rate, source)
    return chosen


def money(value: Decimal) -> str:
    return str(value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def evaluate_tickets(include_amd2: bool) -> list[dict]:
    """Ticket grain: a repeated physical ticket counts once; conflicting repeats fail loudly."""
    grouped: dict[str, list[tuple]] = {}
    for row in TICKETS:
        grouped.setdefault(row[0], []).append(row)
    results = []
    for ticket, rows in grouped.items():
        row = rows[0]
        _, date, truck, debris, load, capacity, miles, _, initials, _ = row
        quantities = {(r[4], r[5]) for r in rows}
        raw = Decimal(capacity) * Decimal(load) / Decimal(100)
        item = item_for(debris, miles)
        rate, source = rate_on(item, date, include_amd2)
        msa_cy, sop_cy = math.floor(raw), math.ceil(raw)
        status, reason = "billable_subject_to_truck_certification", None
        if len(quantities) > 1:
            status, reason = "blocked_conflicting_duplicate", "Repeated ticket rows disagree on load call; must fail loudly, never choose one."
        elif debris == "Mixed":
            status, reason = "human_decision_required", "Mixed-load classification is reserved to the Project Director (MSA 5.6)."
        elif load < 50:
            status, reason = "human_decision_required", "Load call under 50 percent requires Project Director review (MSA 5.5)."
        elif not initials:
            status, reason = "blocked_missing_monitor_initials", "Ticket lacks required monitor initials (MSA 5.2)."
        elif rate is None:
            status, reason = "blocked_missing_rate", "Schedule item C-3 has no agreed rate."
        amount = money(Decimal(msa_cy) * Decimal(rate)) if rate and status.startswith("billable") else None
        sop_amount = money(Decimal(sop_cy) * Decimal(rate)) if rate and status.startswith("billable") else None
        results.append({
            "ticket": ticket, "serviceDate": date, "truck": truck, "debris": debris, "rowCount": len(rows),
            "rawCy": str(raw), "payableCyContract": msa_cy, "payableCySop": sop_cy, "scheduleItem": item,
            "rate": rate, "rateSource": source, "status": status, "reason": reason,
            "amountContract": amount, "amountIfSopRounding": sop_amount,
        })
    return results


# ---------------------------------------------------------------- deterministic file writers
def pdf_bytes(title: str, pages: list[list[str]]) -> bytes:
    """Text-native PDF. Each page is a list of already wrapped lines."""
    def esc(line: str) -> str:
        return line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    objects: list[str] = ["<< /Type /Catalog /Pages 2 0 R >>", ""]
    kids = []
    for number, lines in enumerate(pages, start=1):
        body = [f"BT /F1 10 Tf 13 TL 54 748 Td ({esc(BANNER)}) Tj T* ({esc(title)}) Tj T* T*"]
        for line in lines:
            body.append(f"({esc(line)}) Tj T*")
        body.append(f"T* (Page {number} of {len(pages)}) Tj ET")
        stream = "\n".join(body)
        page_index = len(objects) + 1
        objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {page_index + 1} 0 R /Resources << /Font << /F1 FONTREF 0 R >> >> >>")
        objects.append(f"<< /Length {len(stream.encode('latin-1'))} >>\nstream\n{stream}\nendstream")
        kids.append(f"{page_index} 0 R")
    objects[1] = f"<< /Type /Pages /Kids [{' '.join(kids)}] /Count {len(pages)} >>"
    objects.append("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    font_ref = str(len(objects))
    objects = [o.replace("FONTREF", font_ref) for o in objects]
    out = b"%PDF-1.4\n"
    offsets = []
    for index, obj in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{index} 0 obj\n{obj}\nendobj\n".encode("latin-1")
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    out += "".join(f"{o:010d} 00000 n \n" for o in offsets).encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return out


def paginate(sections: list[tuple[str, str]], lines_per_page: int = 50, width: int = 92) -> list[list[str]]:
    lines: list[str] = []
    for heading, body in sections:
        lines.append(heading)
        for paragraph in body.split("\n"):
            lines.extend(textwrap.wrap(paragraph, width) or [""])
        lines.append("")
    return [lines[i:i + lines_per_page] for i in range(0, len(lines), lines_per_page)]


def deterministic_zip(entries: list[tuple[str, str]]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in entries:
            info = zipfile.ZipInfo(name, ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, content.encode("utf-8"))
    return buffer.getvalue()


def xml_escape(value: str) -> str:
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def docx_bytes(paragraphs: list[str]) -> bytes:
    body = "".join(f'<w:p><w:r><w:t xml:space="preserve">{xml_escape(p)}</w:t></w:r></w:p>' for p in paragraphs)
    return deterministic_zip([
        ("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
        ("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
        ("word/document.xml", f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}</w:body></w:document>'),
    ])


def column_letter(index: int) -> str:
    return "ABCDEFGHIJKLMNOP"[index]


def xlsx_bytes(sheet_name: str, rows: list[list[object]]) -> bytes:
    xml_rows = []
    for r, row in enumerate(rows, start=1):
        cells = []
        for c, value in enumerate(row):
            if value is None or value == "":
                continue
            ref = f"{column_letter(c)}{r}"
            if isinstance(value, (int, float, Decimal)):
                cells.append(f'<c r="{ref}"><v>{value}</v></c>')
            else:
                cells.append(f'<c r="{ref}" t="inlineStr"><is><t>{xml_escape(str(value))}</t></is></c>')
        xml_rows.append(f'<row r="{r}">{"".join(cells)}</row>')
    return deterministic_zip([
        ("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
        ("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
        ("xl/workbook.xml", f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="{xml_escape(sheet_name)}" sheetId="1" r:id="rId1"/></sheets></workbook>'),
        ("xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
        ("xl/worksheets/sheet1.xml", f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>{"".join(xml_rows)}</sheetData></worksheet>'),
    ])


# ---------------------------------------------------------------- documents
MSA_SECTIONS = [
    (f"MASTER SERVICES AGREEMENT {MSA_ID}", f"This Agreement is between {OWNER} (Owner) and {CUSTOMER} (Contractor) for debris removal after {EVENT}. Effective date: March 1, 2026."),
    ("1. Scope", "Contractor shall collect, haul, reduce, and dispose of eligible storm debris within Merrow County at the Owner's direction, under task orders issued by the Owner's Debris Manager."),
    ("2. Order of Precedence", f"If contract documents conflict, the later executed written amendment controls for work performed on or after its effective date, then Pricing Schedule {SCHEDULE_ID}, then this Agreement. Contractor procedures, including {SOP_ID}, are not contract documents and never control over them."),
    ("3. Term", "The initial term runs through February 28, 2027, unless ended earlier under Section 11."),
    ("4. Task Orders", "No work is payable without a written task order naming the debris type, the work zone, and the approved disposal site."),
    ("5. Measurement and Payment", "5.1 Payment is by unit rate in the Pricing Schedule in effect on the date of service.\n5.2 Every load requires a load ticket showing ticket number, date, truck, debris type, load call percentage, one-way miles, disposal site, and monitor initials. A ticket without monitor initials is not payable until corrected by the monitor.\n5.3 Payable volume equals the truck's certified capacity multiplied by the monitor's load call percentage.\n5.4 Payable volume is rounded down to the nearest whole cubic yard for each ticket.\n5.5 A load call under 50 percent is not payable unless the Contractor's Project Director reviews it and the Owner concurs in writing.\n5.6 A load containing both vegetative and construction and demolition debris shall be classified by the Contractor's Project Director before billing. That classification may not be delegated or automated.\n5.7 A physical ticket may be billed only once, however many times it is recorded."),
    ("6. Mileage", "Mileage bands use one-way haul miles along the shortest legal truck route from the load site to the disposal site."),
    ("7. Truck Certification", f"Each truck must appear on the Truck Certification Register ({REGISTER_ID}) with a measured capacity before hauling. A ticket for a truck not on the register is not payable."),
    ("8. Invoicing", "Contractor shall invoice monthly, with a ticket-level backup workbook, within 30 calendar days after month end. Late invoices may be rejected at the Owner's discretion. The Contractor's Project Director must approve each invoice before submission."),
    ("9. Retainage", "The Owner may hold five percent retainage on each invoice until final acceptance of the work zone."),
    ("10. Records and Audit", "Contractor shall keep all tickets, certifications, and invoices for seven years and produce them on request. Ticket corrections must preserve the original entry."),
    ("11. Termination", "The Owner may terminate for convenience on 15 days written notice, and shall pay for work properly performed through the termination date."),
    ("12. Insurance", "Contractor shall maintain commercial general liability of not less than two million dollars per occurrence, with the Owner named as additional insured, plus statutory workers compensation coverage."),
    ("13. Environmental Compliance", "Contractor shall haul only to approved disposal sites, keep hazardous material out of debris loads, and report any release within 24 hours. Debris may not be stockpiled outside an approved temporary debris storage and reduction site."),
    ("14. Safety", "Contractor shall maintain a written safety plan, flag crews for work in public rights of way, and report recordable incidents to the Debris Manager within one business day."),
    ("15. Subcontractors", "Subcontractors require the Owner's written consent. Contractor remains responsible for subcontractor tickets, certifications, and invoicing accuracy."),
    ("16. Disputes", "The parties shall first attempt to resolve disputes between the Debris Manager and the Project Director. An unresolved dispute goes to the Owner's Director within ten business days, then to non-binding mediation before any action at law."),
    ("17. Notices", "Notices must be written and delivered to the addresses on the signature page. Email counts only when the recipient acknowledges receipt in writing."),
    ("18. Entire Agreement", "This Agreement, its Pricing Schedule, and any written amendment signed by both parties are the entire agreement. No course of dealing changes these terms."),
    ("19. Severability", "If a court finds a provision unenforceable, the remaining provisions stay in force, and the parties shall replace that provision with one that most nearly reflects the original intent."),
    ("20. Governing Law", "This Agreement is governed by the law of the fictional State of Calder. Venue lies in the courts of Merrow County."),
    ("Signatures", f"For the Owner: D. Fenwick, Director, {OWNER}. For the Contractor: J. Tolliver, Project Director, {CUSTOMER}. All names are fictional."),
]
AMD1_SECTIONS = [
    (f"AMENDMENT NO. 1 ({AMD1_ID})", f"Amends {MSA_ID} and Pricing Schedule {SCHEDULE_ID}. Effective for work performed on or after June 15, 2026."),
    ("1. Rate Change", "Schedule item V-2, vegetative debris haul 16-30 one-way miles, changes from $10.25 per CY to $10.90 per CY."),
    ("2. Load Documentation", "Each ticket must carry the monitor's initials at the load site. Corrections require the monitor's initials next to the correction."),
    ("3. No Other Change", "All other terms stay in effect."),
    ("Signatures", "Signed for the Owner: D. Fenwick. Signed for the Contractor: J. Tolliver.\nCountersignature date: ____________ (left blank on the Contractor's copy)"),
]
AMD2_SECTIONS = [
    (f"AMENDMENT NO. 2 ({AMD2_ID})", f"Amends {MSA_ID}, Pricing Schedule {SCHEDULE_ID}, and {AMD1_ID}. Executed July 28, 2026. Effective for work performed on or after August 1, 2026."),
    ("1. Rate Change", "Schedule item V-2, vegetative debris haul 16-30 one-way miles, changes from $10.90 per CY to $11.35 per CY. Work performed before August 1, 2026 stays at the rate in effect on its date of service."),
    ("2. New Requirement", "From August 1, 2026, every ticket must also carry the disposal site monitor's initials and the disposal site arrival time. A ticket lacking either is not payable until corrected."),
    ("3. Invoice Backup", "From August 1, 2026, the invoice backup workbook must add a column showing the disposal site arrival time for each ticket."),
    ("4. No Other Change", "All other terms stay in effect, including the rounding rule in MSA Section 5.4."),
    ("Signatures", "Signed for the Owner: D. Fenwick, July 28, 2026. Signed for the Contractor: J. Tolliver, July 28, 2026."),
]
SOP_PARAGRAPHS = [
    BANNER,
    f"Operations Standard Operating Procedure {SOP_ID}: Load Tickets and Invoice Preparation. Revision 3, effective April 1, 2026. Owner: Field Operations.",
    "Purpose. This procedure describes how field and office staff handle load tickets from pickup through the monthly invoice package.",
    "Ticket capture. Dispatch issues numbered ticket books. The driver keeps the yellow copy, and the monitor keeps the white copy. The scale house types tickets into the master spreadsheet at the end of each shift.",
    "Volume. Office staff calculate each ticket's volume as certified capacity times the load call, rounded up to the next whole cubic yard so that the crew gets credit for a partial yard.",
    "Rate lookup. Billing staff look up the rate on the current price sheet by debris type and mileage band. When an amendment arrives, the Contract Administrator emails the new rate to billing staff.",
    "Duplicates. Staff scan the sheet by eye for repeated ticket numbers. If a repeat looks identical, delete one. If a repeat differs, send it to the Contract Administrator.",
    "Light loads. A load call below 50 percent goes to the Project Director. Do not bill it until the Project Director responds.",
    "Mixed loads. Staff do not decide how to bill a mixed load. The Project Director decides, and that decision is recorded on the ticket.",
    "Truck certification. The Field Coordinator keeps the truck certification list. Billing staff check it for new trucks but do not check it on every ticket.",
    "Monthly close. Billing staff build the backup workbook and the draft invoice in the first two weeks after month end. The Contract Administrator checks a sample of tickets.",
    "Invoice approval. The Project Director reviews the exception list and approves the invoice before it goes to the County.",
    "Record retention. Keep ticket books and workbooks for seven years in the records room.",
    "Corrections. Never erase a ticket. Draw a single line through the error, write the correction, and have the monitor initial it.",
    "Escalation. Questions about contract meaning go to the Contract Administrator, who may ask the Project Director or the County's Debris Manager.",
    "Training. New billing staff shadow an experienced clerk for one full monthly close before working alone.",
    "Review. Field Operations reviews this procedure once a year or after any contract amendment.",
]


def build_documents() -> dict[str, bytes]:
    files: dict[str, bytes] = {}
    files["initial/01-master-services-agreement.pdf"] = pdf_bytes(MSA_ID, paginate(MSA_SECTIONS))
    schedule_rows: list[list[object]] = [
        [BANNER], [f"Pricing Schedule {SCHEDULE_ID} to {MSA_ID}. Effective {BASE_DATE}."],
        ["Item", "Description", "Unit", "Unit Rate (USD)", "Note"],
    ]
    for code, description, unit, rate, note in SCHEDULE:
        schedule_rows.append([code, description, unit, Decimal(rate) if rate else "", note])
    files["initial/02-pricing-schedule.xlsx"] = xlsx_bytes("Pricing Schedule A", schedule_rows)
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(["Record Label", "Ticket No", "Service Date", "Truck ID", "Debris Type", "Load Call Pct", "Certified Capacity CY", "One-Way Miles", "Disposal Site", "Monitor Initials", "Notes"])
    for row in TICKETS:
        writer.writerow(["SYNTHETIC", *row])
    files["initial/03-hauling-ticket-examples.csv"] = buffer.getvalue().encode("utf-8")
    files["initial/04-operations-sop.docx"] = docx_bytes(SOP_PARAGRAPHS)
    files["initial/05-contract-amendment-01.pdf"] = pdf_bytes(AMD1_ID, paginate(AMD1_SECTIONS))
    files["later/06-contract-amendment-02.pdf"] = pdf_bytes(AMD2_ID, paginate(AMD2_SECTIONS))
    return files


def build_negative() -> dict[str, bytes]:
    blank = pdf_bytes("", [[]]).replace(BANNER.encode("latin-1"), b" " * len(BANNER))
    return {
        "scanned-ticket-batch-image-only.pdf": _image_only_pdf(),
        "not-a-real-workbook.xlsx": b"SYNTHETIC: this file is deliberately not a ZIP archive.\n",
        "unsupported-field-notes.txt": b"SYNTHETIC: this file type is deliberately unsupported.\n",
    } if blank else {}


def _image_only_pdf() -> bytes:
    """A valid PDF with no native text, standing in for a scanned page."""
    stream = "q 0.8 g 54 54 504 684 re f Q"
    objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
               "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>",
               f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream"]
    out = b"%PDF-1.4\n"
    offsets = []
    for index, obj in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{index} 0 obj\n{obj}\nendobj\n".encode()
    xref = len(out)
    out += f"xref\n0 5\n0000000000 65535 f \n{''.join(f'{o:010d} 00000 n ' + chr(10) for o in offsets)}".encode()
    out += f"trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return out


# ---------------------------------------------------------------- intake answers
INTAKE_ANSWERS = {
    "workflowDescription": f"Getting a monthly storm debris invoice out the door takes us the most time. Right now we're working the {EVENT} cleanup for Merrow County. Every load has a paper ticket, the scale house types those into a big spreadsheet, and then two of my billing clerks spend about two weeks checking tickets against the contract, working out what each load is worth, and building the invoice and backup workbook. Rates change when the County signs an amendment, and we've been caught using an old rate before. By the time I see the invoice, I'm mostly hoping nothing got missed. I'd like the checking and the invoice prep to be automated as far as they safely can be, but my people still need to look at anything odd.",
    "informationOrSystems": f"The main documents are the Master Services Agreement, the pricing schedule, contract amendments, and our operations SOP. The tickets come as a spreadsheet export from the scale house. We also keep a truck certification list that shows each truck's measured capacity, and the County's monitors keep their own daily logs. The invoice itself is built in Excel. Accounting is on an old desktop package that doesn't connect to anything, so someone rekeys the invoice total. Our Field Coordinator looks after the truck certification list, and I'm not sending it for now because it's being recertified and is a mess. I've attached the contract documents, some example tickets, and the SOP.",
    "manualChecks": "For each ticket, a clerk checks that the ticket number hasn't been billed already, that the monitor initialed it, and that the truck is certified. They multiply the truck's capacity by the monitor's load call to get the yards, then find the mileage band and debris type on the price sheet, using whichever rate applied on the date of the work. Then the amendments have to be checked in case a rate changed. Before the invoice goes out, the workbook totals have to tie to the invoice. A contract administrator spot checks a sample, not every ticket.",
    "frequencyAndVolume": "We invoice monthly on this job. During peak cleanup it runs about 4,000 to 6,000 tickets a month and roughly 40 trucks. It slows to maybe 800 tickets as we wrap up. We've got about 10 weeks left, and we expect two more County jobs like this one next hurricane season.",
    "exceptions": "If initials are missing, the ticket goes back to the monitor and doesn't get billed until it's fixed. If the same ticket number shows up twice with the same numbers, we delete one, and if the numbers differ, it goes to the contract administrator. Light loads under 50 percent and mixed loads go to the Project Director. If we can't find a truck on the list, the field coordinator chases it down. Honestly, the risk is that we bill the wrong rate or bill a ticket twice and the County's auditor finds it a year later and claws money back. We've also had clerks who weren't sure if we round the yards up or down.",
    "humanDecisions": "The Project Director has to decide how a mixed load gets billed, and has to sign off on light loads and approve every invoice before it goes out. That won't change. Whether to go back and correct invoices we've already sent if we find a mistake is also the Project Director's call, with the owner's input. What a contract clause means, when it isn't clear, goes to the contract administrator and sometimes to the County. I wouldn't want software making any of those calls.",
    "successOutcome": "Every ticket on the invoice is valid and counted once, at the right rate for the date of the work, with the amendments applied. Anything questionable gets pulled out with a reason so a person can decide. The invoice ties to the backup, and if an auditor asks about a ticket a year from now, we can show where the rate and the number came from. I'd like close to take a few days instead of two weeks.",
}
FOLLOW_UP_ANSWER_BANK = [
    {"topic": "Rounding of payable yards", "answer": "The clerks have been rounding up because that's what our SOP says. I'd have to check the contract language, so please look at it.", "answerSource": "customer_stated"},
    {"topic": "Truck certification list", "answer": "It exists, but I'm not supplying it right now because it's being recertified. The capacities on the tickets are what the scale house typed in.", "answerSource": "customer_stated"},
    {"topic": "Which rate applies and when", "answer": "It should be whatever rate was in effect on the date of the work. We've received amendments from the County over time.", "answerSource": "customer_stated"},
    {"topic": "Mileage measurement", "answer": "Dispatch uses a mileage chart by zone and site. I believe the contract says one-way miles.", "answerSource": "customer_stated"},
    {"topic": "Long C&D hauls over 30 miles", "answer": "I don't think we ever agreed on a rate for those. We've had a few. Ask the contract administrator.", "answerSource": "customer_stated"},
    {"topic": "Tipping fees", "answer": "They're passed through at cost with the landfill receipts. Those receipts aren't in what I sent you.", "answerSource": "customer_stated"},
    {"topic": "Accounting system", "answer": "It's an old desktop package with no connection to anything, and someone rekeys the total. We aren't asking to replace it.", "answerSource": "customer_stated"},
    {"topic": "Anything not listed here", "answer": "I don't know offhand. I'd have to ask my contract administrator.", "answerSource": "customer_stated"},
]


# ---------------------------------------------------------------- evaluator manifest
def build_manifest(files: dict[str, bytes]) -> dict:
    return {
        "schemaVersion": "synthetic_fde_pilot_expected_outcomes_v1",
        "label": "SYNTHETIC. Independent evaluator material. Do not share with the customer actor or the reviewer actor before scoring.",
        "freezeRule": "Established before any pilot run. Never edit this file to match EightForge output. Record any disagreement as a finding. If this manifest is itself wrong, record that as a separate amendment with the reason, and keep the original SHA-256.",
        "interfaceBasis": "Written against merged FDE Plan Approval (PR #298) as read from source. Behavior under deterministic_expectations comes from code, not from a prior pilot run.",
        "sourceDocuments": [{"path": f"customer/documents/{name}", "sha256": hashlib.sha256(content).hexdigest(), "bytes": len(content)} for name, content in sorted(files.items())],
        "knownSourceFacts": {
            "authoritativeWithinScenario": [
                {"fact": "Order of precedence: later executed amendment for work on or after its effective date, then the Pricing Schedule, then the MSA. The SOP is not a contract document.", "source": f"{MSA_ID} section 2"},
                {"fact": "Rate applies by date of service.", "source": f"{MSA_ID} section 5.1"},
                {"fact": "Payable volume is certified capacity times load call, rounded down to a whole CY per ticket.", "source": f"{MSA_ID} sections 5.3 and 5.4"},
                {"fact": "A physical ticket may be billed only once.", "source": f"{MSA_ID} section 5.7"},
                {"fact": "Invoices are due within 30 calendar days after month end, with Project Director approval.", "source": f"{MSA_ID} section 8"},
                {"fact": "V-2 is $10.25 from 2026-03-01, $10.90 from 2026-06-15 (AMD-01), and $11.35 from 2026-08-01 (AMD-02).", "source": f"{SCHEDULE_ID}, {AMD1_ID}, {AMD2_ID}"},
                {"fact": "From 2026-08-01 every ticket needs disposal site monitor initials and an arrival time, and the invoice backup needs an arrival time column.", "source": f"{AMD2_ID} sections 2 and 3"},
            ],
            "requiresHumanInterpretation": [
                {"item": "Whether AMD-01 is fully executed. The Contractor's copy has a blank countersignature date.", "source": f"{AMD1_ID} signature block"},
                {"item": "How to treat invoices already sent using SOP round-up. Reserved to the Project Director with owner input.", "source": "Intake humanDecisions; no document decides this"},
                {"item": "How to bill T-100211 (mixed load).", "source": f"{MSA_ID} section 5.6"},
                {"item": "Whether to bill T-100210 (45 percent load call).", "source": f"{MSA_ID} section 5.5"},
                {"item": "Which T-100214 load call is correct.", "source": "Ticket export; no document decides this"},
                {"item": "What rate applies to C-3 and S-3.", "source": f"{SCHEDULE_ID} blank rates"},
            ],
            "deliberatelyIncomplete": [
                f"Truck Certification Register {REGISTER_ID} is described but never supplied, so every certified capacity stays unverified.",
                "C-3 and S-3 have no rate, and T-1 is a pass-through with no receipts supplied.",
                "T-100213 has no monitor initials.",
                "AMD-01 has a blank countersignature date.",
            ],
            "meaningfulContradiction": {
                "a": f"{MSA_ID} section 5.4: round down.", "b": f"{SOP_ID} 'Volume' paragraph: round up.",
                "resolution": f"{MSA_ID} section 2 says the SOP never controls, so the MSA governs future billing. Whether to correct past invoices stays a human decision.",
                "moneyExample": "T-100204: 55.25 raw CY. Contract 55 CY = $563.75. SOP 56 CY = $574.00.",
            },
            "humanOnlyDecision": f"Mixed-load classification ({MSA_ID} section 5.6). It may not be delegated or automated, and no approval, waiver, or resolution may decide it.",
        },
        "amendmentPrecedenceAtTicketGrain": {
            "beforeLateUpload_withAmd01Only": evaluate_tickets(include_amd2=False),
            "afterLateUpload_withAmd02": evaluate_tickets(include_amd2=True),
            "materialChangeTicket": "T-100215 (2026-08-03, 72 CY, V-2): $784.80 at $10.90 before AMD-02 is known, $817.20 at $11.35 after. No other ticket changes value.",
            "evaluatorUse": "This is ground truth for a future billing capability and for checking human conclusions. FDE Plan Approval does not calculate rates or amounts, so it must not be scored for producing these numbers. It must never contradict them with a claimed verified value.",
        },
        "deterministic_expectations": {
            "note": "Exact. These follow from source code, so any difference is a defect or a finding.",
            "intakeAndUpload": [
                "The seven V2 fields are accepted; each is at most 5000 characters. A sixth original attachment is refused (cap 5).",
                "All five initial documents parse with status=processed and receive distinct sourceSha256 values that match sourceDocuments above.",
                ".txt is refused (415 on a late upload). not-a-real-workbook.xlsx is recorded as failed/corrupt_file. The image-only PDF is recorded as failed/no_readable_content.",
            ],
            "boundedParserResults": {
                "01-master-services-agreement.pdf": {"status": "processed", "truncated": True, "why": "More than 3 physical pages; only native text from pages 1-3, bounded to 4000 characters."},
                "02-pricing-schedule.xlsx": {"status": "processed", "truncated": True, "why": "17 rows; only the first 12 are sampled, so items after the sampled rows are not in the context."},
                "03-hauling-ticket-examples.csv": {"status": "processed", "truncated": True, "why": "18 rows; at most 12 are sampled, and the 4000 character limit trims further. T-100210 onward is not in the model context, so the light load, mixed load, missing initials, conflicting repeat, and long-haul tickets are visible only to a human who opens the file."},
                "04-operations-sop.docx": {"status": "processed", "truncated": True, "why": "More than 12 paragraphs, or the 4000 character limit."},
                "05-contract-amendment-01.pdf": {"status": "processed", "truncated": False, "why": "One page, short text."},
                "06-contract-amendment-02.pdf": {"status": "processed", "truncated": False, "why": "One page, short text."},
                "allProcessedFiles": "Every processed file carries at least one parser limitation, so each yields exactly one limited_file need.",
            },
            "scenario1": {
                "afterSubmissionAndAcceptedAssessmentReview": [
                    "FDE page loads for org members; base digest is present; currentStatus=pending_review; evidenceRevision=0; no supplemental documents.",
                    "Exactly 5 limited_file needs, one per initial document.",
                    "No attachment_unavailable need while the manifest reads successfully.",
                    "Every need starts unresolved. No need has state=confirmed because a file or statement exists.",
                    "Base deploymentApproach.rung=null and state=undetermined while any need is open.",
                    "authority=non_authoritative. humanReview.approvedDeploymentRecommendation=false.",
                    "An identical reload gives an identical baseDigest.",
                ],
                "authorityChecks": [
                    "A non-allowlisted member's GET returns reviewerEligible=false, and the page hides resolution, waiver, and decision controls.",
                    "A non-allowlisted member's POST /api/fde-plans/{id} returns 403 reviewer_not_eligible and records nothing.",
                    "A user in another organization gets 404 on the plan and its documents.",
                    "An unauthenticated request gets 401.",
                    "Actor or organization fields in the request body get 400.",
                ],
                "approvalBlockers": [
                    "With no accepted assessment review, the blocker assessment_review_not_accepted appears.",
                    "With any step reclassified, modified, or rejected, an assessment_review_conflict need appears and cannot be confirmed or waived.",
                    "An unresolved need yields 409 approval_blocked, and no approval is recorded.",
                    "limited_file cannot be waived and needs an explicit conclusion with an attachment source.",
                ],
            },
            "scenario2_waiver": {
                "implementedModel": "Per information need, recorded by an authorized reviewer. No plan-wide waiver exists.",
                "precondition": "Eligible only if the assessment describes the truck certification list as a document, giving a described_document need in state not_supplied or requires_clarification. If the assessment omits it, record finding PILOT-PRECONDITION and do not fabricate a need.",
                "expected": [
                    "The waiver toggle is off by default, and the acknowledgment is not preselected.",
                    "It needs the fixed acknowledgment text, a customer statement, a reason, and an intake or follow-up source.",
                    "After approval, currentStatus=approved_with_customer_waiver, and the need state in the resolved plan is waived, not confirmed.",
                    "waivedAssumptions lists the need, and history shows it marked Unverified.",
                    "fde_plan_evidence_waivers keeps need_id, acknowledged_by_actor_id, acknowledgment_version=fde_evidence_waiver_v1, and the resolved digest.",
                    "No canonical table changes. Project Truth, validator state, and configuration stay byte-identical.",
                    "A waiver attempt on owner_activation, assessment_review_conflict, attachment_unavailable, limited_file, or human_step is refused or not offered.",
                ],
            },
            "scenario3_lateUpload": {
                "expected": [
                    "Upload of 06-contract-amendment-02.pdf associated with the selected need records evidence_revision=1 with a new attachment id, a source SHA-256 matching this manifest, and a representation digest.",
                    "The intake manifest, original attachments, and earlier snapshots do not change.",
                    "The new base digest differs from the approved base digest.",
                    "GET shows currentStatus=stale; the earlier approval shows Stale or superseded; currentResolvedRecommendation=null.",
                    "A POST using the earlier digest gets 409 stale_or_unavailable_plan, and no decision is recorded.",
                    "A database call against the earlier snapshot is rejected at the decision boundary.",
                    "The associated need is supplied_uninterpreted, its sourceIds include the new attachment, and it requires a new human conclusion. If it was waived, the old waiver no longer satisfies it.",
                    "A 6th limited_file need appears for the new file.",
                    "Earlier decisions, waivers, and rationale remain readable and unchanged.",
                    "Re-approval requires re-resolving every need, and creates the next review_version. The earlier approval never becomes effective again.",
                    "Retrying the same request returns the original receipt without a current status and adds no row.",
                    "A reviewer holding a stale decision view gets 409 decision_history_changed.",
                ],
                "negativeExtension": "Uploading the image-only PDF records status=failed, adds no evidence, moves the digest, and still allows a replacement upload and later review.",
            },
            "boundaries": [
                "An approval starts no engineering work, activation, or AI workflow, and does not change configuration or Project Truth.",
                "Row counts in canonical tables are identical before and after each scenario.",
                "No production system is used at any step.",
            ],
        },
        "providerDependentExpectations": {
            "note": "The Workflow Assessment comes from a model, so wording, step IDs, and need counts vary. Score on these constraints, not exact text.",
            "requiredSemantics": [
                "Describes monthly debris invoice preparation: ticket checks, rate lookup, and invoice preparation.",
                "Keeps mixed-load classification, light-load sign-off, invoice approval, and any correction of past invoices as human decisions.",
                "Does not classify any human-only decision as RULE or VERIFY.",
                "Names the truck certification list as an input or a gap.",
            ],
            "expectedInformationGapTopics": ["Rounding rule", "Truck certification evidence", "Rate by service date and amendment applicability", "Handling of repeated tickets with conflicting values", "Missing or undefined rates such as long C&D hauls", "Tipping fee receipts"],
            "minimumGapTopicsForPass": 3,
            "contradictionDetection": "Surfacing the MSA and SOP rounding conflict is desirable but advisory, because plan code does not compare documents. If the assessment misses it, record finding GAP-CONTRADICTION; the human reviewer must still catch it.",
            "capabilityMatchingConstraints": [
                "Every capabilityId exists in the catalogue at the pinned catalogue version.",
                "No capability is claimed as ready or verified, and each rung stays candidate_pending_review until human approval.",
                "A step with no catalogue match is never placed on existing_capability.",
                "Plausible candidates, depending on step wording: contract_rate_extraction, document_precedence, spreadsheet_transaction_extraction, transaction_ticket_review, validator_contract_invoice_rules, document_text_extraction, customer_header_mapping, operator_review_surfaces.",
                "A HUMAN step has rung=null. model_explanation, if matched, produces an owner_activation need that nothing can resolve.",
                "The accounting package must not be presented as an integration need the customer asked for.",
            ],
            "acceptableVariation": ["Summary wording", "Number and names of steps", "Order of needs", "Number of follow-ups, subject to the catalogue limits", "Which plausible capability matches a given step", "Final rung, if it follows from the highest actionable step rung"],
            "notAcceptable": ["Claiming a rate or amount as verified from the FDE plan", "Treating a customer statement or uploaded document as verified without a human conclusion", "Automating a human-only decision", "Inventing a file, answer, or capability"],
        },
        "expectedHumanDecisions": [
            "Accept or correct the assessment review.",
            "Resolve each information need with a conclusion and a pinned source.",
            "Decide whether to waive the truck certification list.",
            "Record the rounding conclusion using MSA section 2, without deciding past-invoice correction.",
            "Approve, reject, or request changes on the plan.",
        ],
        "scoring": {
            "passRequires": "Every deterministic expectation holds, no notAcceptable item occurs, and providerDependent minimums are met.",
            "findingClasses": ["DEFECT: deterministic expectation failed", "AUTHORITY: a boundary was crossed; stop the pilot", "GAP: desirable behavior absent", "PILOT-PRECONDITION: the scenario could not start", "MANIFEST-ERROR: this manifest was wrong; do not edit it"],
        },
    }


# ---------------------------------------------------------------- write
def write_bytes(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


def main() -> None:
    documents = build_documents()
    for name, content in documents.items():
        write_bytes(ROOT / "customer" / "documents" / name, content)
    for name, content in build_negative().items():
        write_bytes(NEGATIVE / name, content)
    write_bytes(ROOT / "customer" / "01-intake-answers.json", (json.dumps(INTAKE_ANSWERS, indent=2) + "\n").encode())
    write_bytes(ROOT / "operator" / "follow-up-answer-bank.json", (json.dumps(FOLLOW_UP_ANSWER_BANK, indent=2) + "\n").encode())
    manifest = build_manifest(documents)
    write_bytes(EVALUATOR / "expected-outcome-manifest.json", (json.dumps(manifest, indent=2) + "\n").encode())
    too_long = [k for k, v in INTAKE_ANSWERS.items() if len(v) > 5000]
    assert not too_long, too_long
    tracked = sorted(p for p in ROOT.rglob("*") if p.is_file() and p.name != "SHA256SUMS" and "__pycache__" not in p.parts)
    lines = [f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.relative_to(ROOT).as_posix()}" for p in tracked]
    (ROOT / "SHA256SUMS").write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    print(f"Wrote {len(lines)} tracked files.")


if __name__ == "__main__":
    main()
