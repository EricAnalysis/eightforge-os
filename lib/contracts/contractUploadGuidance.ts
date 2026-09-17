import type { SupabaseClient } from '@supabase/supabase-js';
import { expandRatePageRanges, type RatePageRange } from '@/lib/contracts/parseRatePageRanges';

export type ContractUploadGuidanceRateScheduleIncluded = 'yes' | 'no' | 'unsure';
export type ContractUploadGuidanceLocationType =
  | 'main_contract'
  | 'exhibit'
  | 'attachment'
  | 'price_sheet'
  | 'unsure';

export type ContractUploadGuidanceRow = {
  id: string;
  organization_id: string;
  project_id: string | null;
  document_id: string;
  rate_schedule_included: ContractUploadGuidanceRateScheduleIncluded;
  rate_schedule_page_ranges: RatePageRange[] | null;
  rate_schedule_location_type: ContractUploadGuidanceLocationType | null;
  operator_note: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

/** Postgres undefined_table / PostgREST table missing from schema cache (PGRST205). */
export function isContractUploadGuidanceTableUnavailableError(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!error) return false;
  const code = error.code ?? '';
  const msg = (error.message ?? '').toLowerCase();

  if (code === 'PGRST205') return true;
  if (code === '42P01' && msg.includes('contract_upload_guidance')) return true;
  if (!msg.includes('contract_upload_guidance')) return false;

  return (
    msg.includes('schema cache') ||
    msg.includes('does not exist') ||
    msg.includes('could not find the table')
  );
}

/**
 * Loads the operator's upload-time rate schedule guidance for a document,
 * if any was captured. Returns null when absent or when the table is not
 * yet migrated — callers should treat this as "no guidance available" and
 * proceed exactly as before this feature existed.
 */
export async function loadContractUploadGuidanceForDocument(
  admin: SupabaseClient,
  documentId: string,
): Promise<ContractUploadGuidanceRow | null> {
  const { data, error } = await admin
    .from('contract_upload_guidance')
    .select(
      'id, organization_id, project_id, document_id, rate_schedule_included, rate_schedule_page_ranges, rate_schedule_location_type, operator_note, created_by, created_at, updated_at',
    )
    .eq('document_id', documentId)
    .maybeSingle();

  if (error) {
    if (isContractUploadGuidanceTableUnavailableError(error)) return null;
    throw new Error(error.message);
  }

  return (data ?? null) as ContractUploadGuidanceRow | null;
}

export function rateSchedulePageHintsFromGuidance(
  guidance: ContractUploadGuidanceRow | null,
): number[] {
  const ranges: readonly unknown[] | null = Array.isArray(guidance?.rate_schedule_page_ranges)
    ? guidance.rate_schedule_page_ranges
    : null;
  if (!ranges) return [];
  const wellFormed = ranges.every((range) => {
    if (typeof range !== 'object' || range == null) return false;
    const candidate = range as { start?: unknown; end?: unknown };
    return Number.isSafeInteger(candidate.start)
      && Number.isSafeInteger(candidate.end)
      && (candidate.start as number) >= 1
      && (candidate.end as number) >= (candidate.start as number);
  });
  // Hints are only a sort preference. Preserve malformed persisted ranges for
  // the pricing-scope resolver to classify as blocked; never throw or turn them
  // into apparent absence before that fail-closed decision.
  return wellFormed ? expandRatePageRanges(ranges as readonly RatePageRange[]) : [];
}

export type ExtractionPageGuidanceState = 'absent' | 'loaded' | 'malformed' | 'unavailable';

export type ExtractionPageGuidance = Readonly<{
  rate_schedule_guidance_state: ExtractionPageGuidanceState;
  rate_schedule_page_hints: readonly number[];
  rate_schedule_page_ranges: readonly RatePageRange[] | null;
  rate_schedule_included: ContractUploadGuidanceRateScheduleIncluded | null;
}>;

/**
 * Operator page guidance as extraction consumes it: where to look first and
 * which pages must receive an explicit coverage decision. Never evidence.
 *
 * A read failure or malformed persisted ranges do not stop extraction, because
 * guidance only widens inspection; every page is still evaluated. The state is
 * carried into the coverage record so the degradation is never silent, and
 * malformed ranges remain blocked by the downstream pricing-scope resolver.
 */
export async function loadExtractionPageGuidance(
  admin: SupabaseClient,
  documentId: string,
): Promise<ExtractionPageGuidance> {
  let guidance: ContractUploadGuidanceRow | null;
  try {
    guidance = await loadContractUploadGuidanceForDocument(admin, documentId);
  } catch (error) {
    console.warn('[contractUploadGuidance] extraction page guidance unavailable', {
      documentId,
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      rate_schedule_guidance_state: 'unavailable',
      rate_schedule_page_hints: [],
      rate_schedule_page_ranges: null,
      rate_schedule_included: null,
    };
  }
  if (!guidance) {
    return {
      rate_schedule_guidance_state: 'absent',
      rate_schedule_page_hints: [],
      rate_schedule_page_ranges: null,
      rate_schedule_included: null,
    };
  }
  const hints = rateSchedulePageHintsFromGuidance(guidance);
  const ranges = guidance.rate_schedule_page_ranges;
  const malformed = ranges != null && (!Array.isArray(ranges) || (ranges.length > 0 && hints.length === 0));
  return {
    rate_schedule_guidance_state: malformed ? 'malformed' : 'loaded',
    rate_schedule_page_hints: hints,
    rate_schedule_page_ranges: malformed ? null : ranges,
    rate_schedule_included: guidance.rate_schedule_included ?? null,
  };
}
