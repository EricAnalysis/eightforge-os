/**
 * Deterministic detection of explicit, numbered amendment references (B7.1, D7).
 *
 * Pure. Recognizes only references that name a number:
 * - `Amendment No. 3`, `Amendment Number 3`, `Amendment #3`, `Amendment 3`,
 *   `Amendment No. Three`, `Amendment Three`;
 * - lists: `Amendment Nos. 1, 2 and 3` (each listed number, never a range);
 * - ordinals: `Third Amendment`, `3rd Amendment`.
 *
 * Unnumbered language ("may be amended", "as amended from time to time",
 * "this Amendment", "any amendment") never matches. Nothing is inferred from
 * chronology, ranges or document order.
 */

export type AmendmentReference = Readonly<{
  /** The amendment number the text names explicitly. */
  number: number;
  /** The matched text, whitespace-collapsed, at most 80 characters. */
  matchedText: string;
  /** Character offset of the match in the normalized text (for deterministic ordering). */
  offset: number;
}>;

const MAX_AMENDMENT_NUMBER = 99;
const MAX_MATCHED_TEXT = 80;

const CARDINAL_WORDS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
};

const ORDINAL_WORDS: Readonly<Record<string, number>> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16,
  seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20,
};

const CARDINAL = Object.keys(CARDINAL_WORDS).join('|');
const ORDINAL = Object.keys(ORDINAL_WORDS).join('|');
/** A number token: digits (not part of a section number, date or larger figure) or a cardinal word. */
const NUMBER_TOKEN = `(?:\\d{1,2}(?![\\d.,/-]\\d)(?!\\d)|(?:${CARDINAL})\\b)`;
const LIST_SEPARATOR = '\\s*(?:,\\s*(?:and\\s+|&\\s*)?|and\\s+|&\\s*)';

/** `Amendment No. 3`, `Amendment #3`, `Amendments Nos. 1, 2 and 3`. */
const LABELED = new RegExp(
  `\\bamendments?\\s*(?:nos?\\.?|numbers?|num\\.?|#)\\s*(${NUMBER_TOKEN}(?:${LIST_SEPARATOR}#?\\s*${NUMBER_TOKEN})*)`,
  'gi',
);
/** `Amendment 3`, `Amendment Three` (singular, no label). */
const BARE = new RegExp(`\\bamendment\\s+(${NUMBER_TOKEN})`, 'gi');
/** `Third Amendment`, `3rd Amendment`. */
const ORDINAL_BEFORE = new RegExp(`\\b((?:${ORDINAL})|\\d{1,2}(?:st|nd|rd|th))\\s+amendment\\b`, 'gi');

function numberFromToken(token: string): number | null {
  const lower = token.trim().toLowerCase();
  const value = /^\d+$/u.test(lower)
    ? Number(lower)
    : CARDINAL_WORDS[lower] ?? ORDINAL_WORDS[lower] ?? (/^(\d{1,2})(?:st|nd|rd|th)$/u.exec(lower)?.[1] != null
      ? Number(/^(\d{1,2})/u.exec(lower)![1])
      : null);
  return value != null && value >= 1 && value <= MAX_AMENDMENT_NUMBER ? value : null;
}

function normalize(text: string): string {
  return text.replace(/\s+/gu, ' ');
}

function snippet(text: string): string {
  const collapsed = text.trim();
  return collapsed.length > MAX_MATCHED_TEXT ? collapsed.slice(0, MAX_MATCHED_TEXT) : collapsed;
}

/** Every explicit numbered amendment reference in the text, ordered by position then number. */
export function detectNumberedAmendmentReferences(text: string): AmendmentReference[] {
  const normalized = normalize(text);
  const found = new Map<string, AmendmentReference>();
  const add = (number: number | null, matchedText: string, offset: number) => {
    if (number == null) return;
    const key = `${offset}:${number}`;
    if (!found.has(key)) found.set(key, { number, matchedText: snippet(matchedText), offset });
  };

  const labeledSpans: Array<[number, number]> = [];
  for (const match of normalized.matchAll(LABELED)) {
    const list = match[1] ?? '';
    labeledSpans.push([match.index!, match.index! + match[0].length]);
    for (const token of list.split(new RegExp(LIST_SEPARATOR, 'iu'))) {
      add(numberFromToken(token.replace(/^#\s*/u, '')), match[0], match.index!);
    }
  }
  for (const match of normalized.matchAll(BARE)) {
    // A labeled match already covers `Amendment No. 3`; never count the same span twice.
    if (labeledSpans.some(([start, end]) => match.index! >= start && match.index! < end)) continue;
    add(numberFromToken(match[1] ?? ''), match[0], match.index!);
  }
  for (const match of normalized.matchAll(ORDINAL_BEFORE)) {
    add(numberFromToken(match[1] ?? ''), match[0], match.index!);
  }

  return [...found.values()].sort((left, right) => left.offset - right.offset || left.number - right.number);
}

/**
 * The amendment number a document is identified with by its own title or file
 * name: exactly one distinct number, else none. The title is preferred; the
 * file name (underscores, dashes and extension normalized) is used only when
 * the title names none. Several distinct numbers are ambiguous and identify
 * nothing.
 */
export function amendmentNumberFromIdentity(title: string | null | undefined, name: string | null | undefined): number | null {
  const fromText = (text: string | null | undefined): number | null | 'ambiguous' => {
    if (!text) return null;
    const numbers = new Set(detectNumberedAmendmentReferences(text).map((reference) => reference.number));
    if (numbers.size === 0) return null;
    return numbers.size === 1 ? [...numbers][0]! : 'ambiguous';
  };
  const fromTitle = fromText(title);
  if (fromTitle === 'ambiguous') return null;
  if (fromTitle != null) return fromTitle;
  const fileName = name?.replace(/\.[a-z0-9]{2,5}$/iu, '').replace(/[_]+/gu, ' ').replace(/(?<=[a-z])-(?=\d)|(?<=\d)-(?=[a-z])/giu, ' ');
  const fromName = fromText(fileName);
  return fromName === 'ambiguous' ? null : fromName;
}
