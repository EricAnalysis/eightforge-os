import { NextRequest, NextResponse } from 'next/server';
import {
  isContractUploadGuidanceTableUnavailableError,
  type ContractUploadGuidanceLocationType,
  type ContractUploadGuidanceRateScheduleIncluded,
  type ContractUploadGuidanceRow,
} from '@/lib/contracts/contractUploadGuidance';
import { RatePageRangeParseError, parseRatePageRanges } from '@/lib/contracts/parseRatePageRanges';
import { getActorContext } from '@/lib/server/getActorContext';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

const RATE_SCHEDULE_INCLUDED_VALUES = ['yes', 'no', 'unsure'] as const;
const LOCATION_TYPE_VALUES = ['main_contract', 'exhibit', 'attachment', 'price_sheet', 'unsure'] as const;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function isRateScheduleIncluded(
  value: unknown,
): value is ContractUploadGuidanceRateScheduleIncluded {
  return (
    typeof value === 'string' &&
    (RATE_SCHEDULE_INCLUDED_VALUES as readonly string[]).includes(value)
  );
}

function isLocationType(value: unknown): value is ContractUploadGuidanceLocationType {
  return (
    typeof value === 'string' &&
    (LOCATION_TYPE_VALUES as readonly string[]).includes(value)
  );
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: documentId } = await params;

  const ctx = await getActorContext(req);
  if (!ctx.ok) return jsonError(ctx.error, ctx.status);
  const { actorId, organizationId } = ctx.actor;

  const admin = getSupabaseAdmin();
  if (!admin) return jsonError('Server not configured', 503);

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return jsonError('Invalid request body', 400);
  }

  const rateScheduleIncluded = body.rateScheduleIncluded;
  if (!isRateScheduleIncluded(rateScheduleIncluded)) {
    return jsonError('rateScheduleIncluded must be yes, no, or unsure', 400);
  }

  const locationType =
    body.rateScheduleLocationType == null || body.rateScheduleLocationType === ''
      ? null
      : body.rateScheduleLocationType;
  if (locationType != null && !isLocationType(locationType)) {
    return jsonError(
      'rateScheduleLocationType must be main_contract, exhibit, attachment, price_sheet, or unsure',
      400,
    );
  }

  let pageRanges: ReturnType<typeof parseRatePageRanges> = [];
  if (typeof body.rateSchedulePageRangesText === 'string' && body.rateSchedulePageRangesText.trim()) {
    try {
      pageRanges = parseRatePageRanges(body.rateSchedulePageRangesText);
    } catch (error) {
      if (error instanceof RatePageRangeParseError) {
        return jsonError(error.message, 400);
      }
      throw error;
    }
  }

  const operatorNote =
    typeof body.operatorNote === 'string' && body.operatorNote.trim().length > 0
      ? body.operatorNote.trim()
      : null;

  const { data: document, error: documentError } = await admin
    .from('documents')
    .select('id, organization_id, project_id')
    .eq('id', documentId)
    .maybeSingle();

  if (documentError) return jsonError(documentError.message, 500);
  if (!document || document.organization_id !== organizationId) {
    return jsonError('Document not found', 404);
  }

  const { data: upserted, error: upsertError } = await admin
    .from('contract_upload_guidance')
    .upsert(
      {
        organization_id: organizationId,
        project_id: document.project_id ?? null,
        document_id: documentId,
        rate_schedule_included: rateScheduleIncluded,
        rate_schedule_page_ranges: pageRanges.length > 0 ? pageRanges : null,
        rate_schedule_location_type: locationType,
        operator_note: operatorNote,
        created_by: actorId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'document_id' },
    )
    .select(
      'id, organization_id, project_id, document_id, rate_schedule_included, rate_schedule_page_ranges, rate_schedule_location_type, operator_note, created_by, created_at, updated_at',
    )
    .single();

  if (upsertError) {
    if (isContractUploadGuidanceTableUnavailableError(upsertError)) {
      return jsonError(
        'Upload guidance is not available yet (table missing or not exposed in PostgREST schema cache). Apply the contract_upload_guidance migration and reload the API schema.',
        503,
      );
    }
    return jsonError(upsertError.message, 500);
  }

  return NextResponse.json({
    ok: true,
    guidance: upserted as ContractUploadGuidanceRow,
  });
}
