import { NextResponse } from 'next/server';
import { getActorContext } from '@/lib/server/getActorContext';
import { loadScopedProject } from '@/lib/server/projectAdmin';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import type { StateProjectionRecordType, StateProjectionShadowMismatch } from '@/lib/stateProjectionShadow';

const MAX_BATCH_SIZE = 50;
const RECORD_TYPES: readonly StateProjectionRecordType[] = [
  'document',
  'project_validation_finding',
  'execution_item',
];

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function isRecordType(value: unknown): value is StateProjectionRecordType {
  return typeof value === 'string' && RECORD_TYPES.includes(value as StateProjectionRecordType);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function parseMismatch(value: unknown, projectId: string): StateProjectionShadowMismatch | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const recordType = record.record_type;
  const recordId = nonEmptyString(record.record_id);
  const payloadProjectId = nonEmptyString(record.project_id);
  const legacyValue = nonEmptyString(record.legacy_value);
  const surface = nonEmptyString(record.surface);
  const timestamp = nonEmptyString(record.timestamp);
  const persistedValue = record.persisted_value;

  if (
    !isRecordType(recordType)
    || !recordId
    || payloadProjectId !== projectId
    || !legacyValue
    || !(persistedValue == null || typeof persistedValue === 'string')
    || !surface
    || !timestamp
    || Number.isNaN(Date.parse(timestamp))
  ) {
    return null;
  }

  return {
    record_type: recordType,
    record_id: recordId,
    project_id: payloadProjectId,
    legacy_value: legacyValue,
    persisted_value: persistedValue ?? null,
    surface,
    timestamp,
  };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  if (!projectId) return jsonError('Project id is required', 400);

  const ctx = await getActorContext(request);
  if (!ctx.ok) return jsonError(ctx.error, ctx.status);

  const admin = getSupabaseAdmin();
  if (!admin) return jsonError('Server not configured', 503);

  const project = await loadScopedProject(admin, {
    organizationId: ctx.actor.organizationId,
    projectId,
  });
  if (!project) return jsonError('Project not found', 404);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  if (!Array.isArray(body)) {
    return jsonError('Expected an array of state projection mismatches', 400);
  }
  if (body.length > MAX_BATCH_SIZE) {
    return jsonError(`Batch size cannot exceed ${MAX_BATCH_SIZE}`, 400);
  }

  const mismatches = body.map((item) => parseMismatch(item, projectId));
  if (mismatches.some((item) => item == null)) {
    return jsonError('Invalid state projection mismatch payload', 400);
  }

  if (mismatches.length === 0) {
    return NextResponse.json({ ok: true, inserted: 0 });
  }

  const rows = (mismatches as StateProjectionShadowMismatch[]).map((mismatch) => ({
    record_type: mismatch.record_type,
    record_id: mismatch.record_id,
    project_id: mismatch.project_id,
    organization_id: project.organization_id,
    legacy_value: mismatch.legacy_value,
    persisted_value: mismatch.persisted_value,
    surface: mismatch.surface,
    created_at: mismatch.timestamp,
  }));

  const { error } = await admin
    .from('state_projection_shadow_mismatches')
    .insert(rows);

  if (error) return jsonError(error.message, 500);

  return NextResponse.json({ ok: true, inserted: rows.length });
}
