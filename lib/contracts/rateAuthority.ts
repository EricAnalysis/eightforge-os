/**
 * Whether a priced row's rate is pricing authority (Forgewing generalization,
 * phase 2: scanned numeric authority).
 *
 * A deterministic reader that succeeded is not the same as a value that is
 * true. A rate read from a scan (OCR) can be a well-formed, confident and
 * wrong number, and OCR confidence does not separate right from wrong, so no
 * threshold is applied. Such a rate is held as a CANDIDATE for a person to
 * confirm or correct through the existing region-bound reviewed-value path
 * (`human_fact_assertions`, superseding the machine row under B3.1). Until
 * then the row carries no rate, and nothing downstream may re-derive one from
 * its raw text.
 *
 * `read` means the authored amount was read whole from native PDF text.
 */
export type ContractRateAuthority =
  | Readonly<{ status: 'read'; basis: 'native_text' }>
  | Readonly<{
      status: 'review_required';
      basis: 'scanned_source' | 'unreadable_amount';
      /** What the deterministic reader saw. Evidence for the reviewer, never a rate. */
      candidate_rate: number | null;
      candidate_rate_raw: string;
    }>;

export type ScannedSourceRef = Readonly<{
  observation_id?: string | number | null;
  source?: string | null;
}>;

/**
 * True when any fragment of the evidence came from OCR: by the fragment's own
 * source, or by the persisted layout observation it is bound to. A fragment
 * whose origin is not recorded is treated as native text, as it was before
 * this gate; production extraction always records it.
 */
export function evidenceIsScanned(
  refs: readonly ScannedSourceRef[],
  observationMethodById?: ReadonlyMap<string, string> | null,
): boolean {
  return refs.some((ref) => ref.source === 'ocr_fallback'
    || ref.source === 'vision'
    || (ref.observation_id != null
      && observationMethodById?.get(String(ref.observation_id)) === 'ocr_fallback'));
}

/** The rate a row may publish, and the authority record that explains it. */
export function decideRateAuthority(params: Readonly<{
  parsedRate: number | null;
  rawText: string;
  scanned: boolean;
}>): { rate: number | null; authority: ContractRateAuthority } {
  if (params.scanned) {
    return { rate: null, authority: { status: 'review_required', basis: 'scanned_source',
      candidate_rate: params.parsedRate, candidate_rate_raw: params.rawText } };
  }
  if (params.parsedRate == null) {
    return { rate: null, authority: { status: 'review_required', basis: 'unreadable_amount',
      candidate_rate: null, candidate_rate_raw: params.rawText } };
  }
  return { rate: params.parsedRate, authority: { status: 'read', basis: 'native_text' } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strict read of a persisted authority record; anything malformed is null. */
export function parseContractRateAuthority(value: unknown): ContractRateAuthority | null {
  if (!isRecord(value)) return null;
  if (value.status === 'read' && value.basis === 'native_text') return { status: 'read', basis: 'native_text' };
  if (value.status !== 'review_required') return null;
  if (value.basis !== 'scanned_source' && value.basis !== 'unreadable_amount') return null;
  const candidate = value.candidate_rate;
  if (candidate !== null && (typeof candidate !== 'number' || !Number.isFinite(candidate))) return null;
  if (typeof value.candidate_rate_raw !== 'string') return null;
  return { status: 'review_required', basis: value.basis, candidate_rate: candidate,
    candidate_rate_raw: value.candidate_rate_raw };
}

/** A row whose authority withholds its rate publishes none, whatever its text says. */
export function rateWithheldByAuthority(authority: ContractRateAuthority | null | undefined): boolean {
  return authority?.status === 'review_required';
}
