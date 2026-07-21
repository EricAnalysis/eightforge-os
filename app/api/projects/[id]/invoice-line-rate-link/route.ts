import { NextResponse } from 'next/server';
import { getActorContext } from '@/lib/server/getActorContext';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { insertManualRateLink, closeManualRateLinkFindings } from '@/lib/server/manualRateLinkClosure';
import {
  findManualRateLinkOption,
  loadManualRateLinkOptions,
  ManualRateLinkOptionsError,
} from '@/lib/server/manualRateLinkOptions';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function optionsErrorResponse(error: unknown) {
  if (error instanceof ManualRateLinkOptionsError) {
    return jsonError(error.message, error.status);
  }
  return jsonError(error instanceof Error ? error.message : 'Unable to load rate options', 500);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  const ctx = await getActorContext(request);
  if (!ctx.ok) return jsonError(ctx.error, ctx.status);

  const invoiceLineSubjectId = new URL(request.url).searchParams.get('invoice_line_subject_id');
  if (!invoiceLineSubjectId) {
    return jsonError('invoice_line_subject_id is required', 400);
  }

  try {
    const result = await loadManualRateLinkOptions({
      projectId,
      organizationId: ctx.actor.organizationId,
      invoiceLineSubjectId,
    });
    return NextResponse.json(result);
  } catch (error) {
    return optionsErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;

  const ctx = await getActorContext(request);
  if (!ctx.ok) return jsonError(ctx.error, ctx.status);
  const { actorId, organizationId } = ctx.actor;

  const admin = getSupabaseAdmin();
  if (!admin) return jsonError('Server not configured', 503);

  // Verify the project belongs to the actor's organization
  const { data: project, error: projectError } = await admin
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (projectError) return jsonError(projectError.message, 500);
  if (!project) return jsonError('Project not found', 404);

  let body: Record<string, unknown> = {};
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  // Required fields
  const invoiceDocumentId = typeof body.invoice_document_id === 'string' ? body.invoice_document_id : null;
  const invoiceLineSubjectId = typeof body.invoice_line_subject_id === 'string' ? body.invoice_line_subject_id : null;
  const contractDocumentId = typeof body.contract_document_id === 'string' ? body.contract_document_id : null;
  const contractRateRowId = typeof body.contract_rate_row_id === 'string' ? body.contract_rate_row_id : null;

  if (!invoiceDocumentId || !invoiceLineSubjectId || !contractDocumentId || !contractRateRowId) {
    return jsonError(
      'invoice_document_id, invoice_line_subject_id, contract_document_id, and contract_rate_row_id are required',
      400,
    );
  }

  const reason = typeof body.reason === 'string' ? body.reason : null;

  let canonicalOptions;
  try {
    canonicalOptions = await loadManualRateLinkOptions({
      projectId,
      organizationId,
      invoiceLineSubjectId,
    });
  } catch (error) {
    return optionsErrorResponse(error);
  }

  if (canonicalOptions.invoiceLine.documentId !== invoiceDocumentId) {
    return jsonError('Invoice line does not belong to the supplied invoice document', 400);
  }

  const selectedOption = findManualRateLinkOption(canonicalOptions, {
    documentId: contractDocumentId,
    recordId: contractRateRowId,
  });
  if (!selectedOption) {
    return jsonError(
      'Selected contract rate row is not part of this project\'s governing pricing family',
      400,
    );
  }

  // Insert (or supersede) the link
  const linkResult = await insertManualRateLink({
    admin,
    organizationId,
    projectId,
    invoiceDocumentId,
    invoiceLineSubjectId,
    invoiceLineNumber: canonicalOptions.invoiceLine.lineNumber,
    invoiceLineDescription: canonicalOptions.invoiceLine.description,
    invoiceLineBillingCode: canonicalOptions.invoiceLine.billingCode,
    contractDocumentId,
    contractRateRowId,
    rateRowDescription: selectedOption.description,
    rateRowUnitType: selectedOption.unitType,
    rateRowRateAmount: selectedOption.rateAmount,
    actorId,
    reason,
  });

  if (!linkResult.ok) {
    return jsonError(linkResult.error, linkResult.status);
  }

  // Close eligible findings; validation-time injection keeps the mapping durable.
  const closureResult = await closeManualRateLinkFindings({
    admin,
    organizationId,
    projectId,
    invoiceLineSubjectId,
    actorId,
    contractRateRowId,
    rateRowDescription: selectedOption.description,
    reason,
  });

  if (closureResult.errors.length > 0) {
    console.error('[invoice-line-rate-link] closure completed with errors', {
      projectId,
      invoiceLineSubjectId,
      errors: closureResult.errors,
    });
  }

  return NextResponse.json({
    ok: true,
    linkId: linkResult.linkId,
    supersededLinkId: linkResult.supersededLinkId,
    closedFindings: closureResult.closedFindings,
    closureErrors: closureResult.errors,
  });
}
