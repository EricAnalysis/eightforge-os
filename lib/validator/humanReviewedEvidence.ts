/**
 * The visible authority marker for human-reviewed values (B3.1).
 *
 * Validator evidence carries human-reviewed provenance in its note, which
 * every pack, the persisted evidence rows and the Ask snippet already keep.
 * Renderers must not rely on the value alone: they test this marker and show
 * the authority explicitly. One prefix, owned here, used by every writer and
 * reader.
 */
export const HUMAN_REVIEWED_EVIDENCE_PREFIX = 'Human-reviewed';

export function isHumanReviewedEvidenceNote(note: string | null | undefined): boolean {
  return typeof note === 'string' && note.startsWith(HUMAN_REVIEWED_EVIDENCE_PREFIX);
}
