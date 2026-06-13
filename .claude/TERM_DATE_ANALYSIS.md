# Term Date Derivation Analysis - Williamson Contract

## Status
- **Page 2 Extraction**: ✅ Working (3825 chars confirmed extracted March 29)
- **Term Dates**: ❌ Still missing (term_start_date, term_end_date, expiration_date)

## Code Path for Term Date Derivation

**File**: `lib/pipeline/nodes/normalizeNode.ts`

### Step 1: Executed Date Detection (Line 1820-1827)

The derivation rule requires `executedDate` to be populated first:

```javascript
const executedCandidateStructured = document.structured_fields.executed_date;
const executedCandidateRegex = executedDateEvidence?.value;
const executedDate = firstNonEmptyString(
  executedCandidateStructured,
  executedCandidateRegex,
  executedCandidateTypedEffective,
  executedCandidateTypedContract,
);
```

**Executed Date Search Regex** (Line 1782-1784):
```regex
(?:contract\s+execution|executed|effective)[^0-9A-Za-z]{0,24}([A-Za-z]+\s+\d{1,2},\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})
```

This looks for:
- "contract execution" OR "executed" OR "effective"
- Followed by 0-24 non-alphanumeric chars
- Followed by a date in format: "Month DD, YYYY" or "D/D/YY"

**⚠️ CRITICAL CHECK**: Does the Williamson contract signature block contain "Executed", "Effective", or "Contract Execution" followed by a date?

If `executedDate` is null/missing, the term derivation will be skipped entirely (line 1137: `if (!executedDate?.trim()) return null;`)

### Step 2: Term Duration Derivation (Lines 1133-1154)

**Function**: `tryDeriveTermEndFromExecutedRelativeDuration()`

This function:
1. Requires a valid `executedDate` ✅ (prerequisite)
2. Joins all contract text from multiple sources (line 1041-1054):
   - `document.evidence` (all evidence blobs)
   - `document.text_preview` (12000 chars)
   - `content_layers_v1.pdf.text.pages` (✅ includes page 2)
   - `document.extraction_data.extraction.evidence_v1.page_text` (legacy)

3. Searches the joined text with two regex patterns:

### Pattern A: Duration → Anchor (Line 1001)

```regex
(\d{1,4}|[a-z]+(?:\s+[a-z]+){0,2})\s*(?:\(([0-9]{1,4})\)\s*)?\s*(day|days)\b
[\s\S]{0,180}?
from\s+the\s+date\s+(?:it\s+is\s+)?(?:fully\s+)?executed|from\s+the\s+date\s+of\s+execution
```

This matches:
- `(90|ninety) days` (or similar duration)
- Within 180 characters
- Followed by `from the date it is fully executed` or `from the date of execution`

### Pattern B: Anchor → Duration (Line 1006)

```regex
from\s+the\s+date\s+(?:it\s+is\s+)?(?:fully\s+)?executed|from\s+the\s+date\s+of\s+execution
[\s\S]{0,180}?
(\d{1,4}|[a-z]+(?:\s+[a-z]+){0,2})\s*(?:\(([0-9]{1,4})\)\s*)?\s*(day|days)\b
```

Same but in reverse order.

## Why Term Dates Are Missing - Diagnostic Checklist

### ❌ Issue 1: executedDate Is Null
**Symptom**: Term derivation is skipped entirely  
**How to check**: In the database, does the document have:
- `structured_fields.executed_date` set? OR
- Evidence blob matching the executed date regex (contract execution + date)?

**What to look for in page 1-2**:
- "Date Executed: [DATE]"
- "Date of Execution: [DATE]"
- "Executed on: [DATE]"
- "Effective Date: [DATE]"
- Any of these near a date pattern

### ❌ Issue 2: Page 2 Text Missing Term Clause
**Symptom**: Page 2 has 3825 chars but doesn't contain "90 days" + "fully executed"  
**How to check**: Examine `content_layers_v1.pdf.text.pages[1].text` for:
- `90 days` (or `ninety days`, `90-day`, etc.)
- `fully executed` (or `of execution`, `from the date of execution`)
- Both within 180 characters of each other

**Possible causes**:
- OCR read page 2 but skipped this specific clause (OCR artifact)
- Clause uses different wording: "ninety-day", "90-day period", "execution date" vs "fully executed"
- Spacing is unusual (multiple spaces, line breaks) breaking regex

### ❌ Issue 3: Regex Pattern Mismatch
**Symptom**: Page 2 has the clause but doesn't match the regex  
**How to check**: Extract the exact text snippet containing both duration + anchor, then test against regex patterns A and B above

**Common mismatch reasons**:
- **Spacing**: `90  days` (double space) vs `90 days` (single space) - ❌ Won't match `\s+`
- **Punctuation**: `90-days from` vs `90 days from` - May break duration parsing
- **Wording variant**: `ninety` as spelled-out number, not `[a-z]+` pattern
- **Anchor variant**: `execution date` vs `executed` (anchor regex only matches specific forms)
- **Distance**: Duration and anchor are >180 characters apart - ❌ Won't match

### ❌ Issue 4: Date Parsing Failure
**Symptom**: Clause matches but derivation returns null  
**How to check**: `parseExecutedRelativeDayCountFromGroups()` (line 1056-1071)
- Does the duration match capture group `[1]` correctly?
- Is the number parseable? (1-3660 days range)
- Is it being filtered as "payment adjacent"? (line 1081)

## Next Steps to Debug

### Option 1: Direct Database Inspection (when server is accessible)

Run against the newest Williamson extraction (`625fb21c-...`):

```sql
-- Check if executedDate can be found
SELECT 
  id,
  (data->'structured_fields'->>'executed_date') as exec_from_structured,
  (data->'extraction'->'evidence_v1'->>'text_preview') as text_preview_start
FROM document_extractions
WHERE id = '625fb21c-2755-4c58-b92d-a74beaf2c5fa'
LIMIT 1;

-- Check page 2 content
SELECT 
  jsonb_array_length(data->'content_layers_v1'->'pdf'->'text'->'pages') as page_count,
  data->'content_layers_v1'->'pdf'->'text'->'pages'->1->>'text' as page_2_text
FROM document_extractions
WHERE id = '625fb21c-2755-4c58-b92d-a74beaf2c5fa'
LIMIT 1;
```

### Option 2: Run Test Script

Use the debug endpoint when server is running:
```bash
curl http://localhost:3000/api/debug/extraction/625fb21c-2755-4c58-b92d-a74beaf2c5fa
```

Then verify:
1. Is `executedDate` present in the normalization output?
2. Is page 2 text in the joined haystack?
3. Does page 2 text contain "90 days" + "fully executed"?
4. Do the two regexes (A & B) match the clause?

### Option 3: Manual Regex Testing

Extract page 2 text and test against the patterns:

```javascript
const page2Text = "...extracted text...";
const durationThenAnchor = /(\d{1,4}|[a-z]+(?:\s+[a-z]+){0,2})\s*(?:\(([0-9]{1,4})\)\s*)?\s*(day|days)\b[\s\S]{0,180}?from\s+the\s+date\s+(?:it\s+is\s+)?(?:fully\s+)?executed|from\s+the\s+date\s+of\s+execution/gi;

const match = durationThenAnchor.exec(page2Text.toLowerCase());
console.log('Match:', match ? match[0] : 'NO MATCH');
```

## Summary

The term date derivation pipeline requires **two conditions**:

1. ✅ **Page 2 extraction**: Working (confirmed 3825 chars)
2. ⚠️ **executedDate present**: UNKNOWN - need to verify
3. ⚠️ **Clause text matching regex**: UNKNOWN - need to inspect page 2 content

The most likely failure point is either:
- **A**: `executedDate` not being found (check signature block for date patterns)
- **B**: Page 2 clause using non-matching wording (e.g., "execution date" vs "fully executed")
- **C**: Clause spacing or formatting preventing regex match (OCR artifacts)

Once the extraction data is accessible, running the diagnostic queries above will pinpoint the exact issue.
