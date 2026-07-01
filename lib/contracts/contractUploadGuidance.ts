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
  if (!guidance?.rate_schedule_page_ranges) return [];
  return expandRatePageRanges(guidance.rate_schedule_page_ranges);
}
