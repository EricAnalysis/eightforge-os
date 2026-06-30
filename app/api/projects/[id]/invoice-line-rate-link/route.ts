import { NextResponse } from 'next/server';
import { getActorContext } from '@/lib/server/getActorContext';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { insertManualRateLink, closeManualRateLinkFindings } from '@/lib/server/manualRateLinkClosure';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
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

  // Optional stability anchor fields
  const invoiceLineNumber = typeof body.invoice_line_number === 'string' ? body.invoice_line_number : null;
  const invoiceLineDescription = typeof body.invoice_line_description === 'string' ? body.invoice_line_description : null;
  const invoiceLineBillingCode = typeof body.invoice_line_billing_code === 'string' ? body.invoice_line_billing_code : null;
  const rateRowDescription = typeof body.rate_row_description === 'string' ? body.rate_row_description : null;
  const rateRowUnitType = typeof body.rate_row_unit_type === 'string' ? body.rate_row_unit_type : null;
  const rateRowRateAmount = typeof body.rate_row_rate_amount === 'number' ? body.rate_row_rate_amount : null;
  const reason = typeof body.reason === 'string' ? body.reason : null;

  // Insert (or supersede) the link
  const linkResult = await insertManualRateLink({
    admin,
    organizationId,
    projectId,
    invoiceDocumentId,
    invoiceLineSubjectId,
    invoiceLineNumber,
    invoiceLineDescription,
    invoiceLineBillingCode,
    contractDocumentId,
    contractRateRowId,
    rateRowDescription,
    rateRowUnitType,
    rateRowRateAmount,
    actorId,
    reason,
  });

  if (!linkResult.ok) {
    return jsonError(linkResult.error, linkResult.status);
  }

  // One-time closure bridge: resolve the currently-open finding for this invoice line.
  // PASS 1 KNOWN LIMITATION: The next re-validation run will reopen this finding
  // because matchRateScheduleItemForInvoiceLine has no injection point yet.
  // Pass 2 will consult invoice_line_rate_links during validation to prevent reopening.
  const closureResult = await closeManualRateLinkFindings({
    admin,
    organizationId,
    projectId,
    invoiceLineSubjectId,
    actorId,
    contractRateRowId,
    rateRowDescription,
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
    closurePath: closureResult.closurePath,
    closedFindingIds: closureResult.closedFindingIds,
    closureErrors: closureResult.errors,
  });
}
