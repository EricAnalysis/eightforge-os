import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';

vi.mock('@/lib/server/supabaseAdmin', () => ({
  getSupabaseAdmin: vi.fn(),
}));

import {
  buildValidationInputsSnapshotHash,
  loadProjectValidationPhase,
  shouldSkipUnchangedValidationInputs,
} from '@/lib/validator/triggerProjectValidation';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

function configureValidationPhaseQuery(result: {
  data: { validation_phase?: string | null } | null;
  error: { code?: string | null; message?: string | null } | null;
}) {
  const maybeSingle = vi.fn().mockResolvedValue(result);
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn((_columns: string) => ({ eq }));
  const from = vi.fn(() => ({ select }));
  vi.mocked(getSupabaseAdmin).mockReturnValue({ from } as never);
  return { from, select };
}

describe('validation trigger input fingerprint', () => {
  it('reads the persisted validation phase into the trigger fingerprint inputs', async () => {
    const query = configureValidationPhaseQuery({
      data: { validation_phase: 'billing_review' },
      error: null,
    });

    assert.equal(await loadProjectValidationPhase('project-1'), 'billing_review');
    assert.equal(query.from.mock.calls.length, 1);
    assert.deepEqual(query.select.mock.calls[0], ['validation_phase']);
  });

  it('surfaces a validation phase query error without synthesizing contract_setup', async () => {
    const query = configureValidationPhaseQuery({
      data: null,
      error: {
        code: '42703',
        message: 'column projects.validation_phase does not exist',
      },
    });

    await assert.rejects(
      () => loadProjectValidationPhase('project-1'),
      /Failed to load project validation phase: column projects\.validation_phase does not exist/,
    );
    assert.equal(query.from.mock.calls.length, 1);
    assert.equal(query.select.mock.calls.length, 1);
  });

  it('changes when a contract reprocess updates persisted contract rate rows', () => {
    const before = buildValidationInputsSnapshotHash({
      ticketCount: 10,
      factCount: 5,
      precedenceFingerprint: 'precedence-1',
      validationPhase: 'billing_review',
      documentSnapshots: [
        {
          id: 'contract-doc',
          processed_at: '2026-05-26T14:38:00.000Z',
          intelligence_trace: {
            contract_analysis: {
              pricing_model: {
                rate_schedule_present: { value: true },
              },
              rate_schedule_rows: [
                {
                  row_id: 'exhibit_a_table:row-1a',
                  description: 'from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles',
                  unit: 'Cubic Yard',
                  rate: 19.8,
                  page: 8,
                  source_kind: 'exhibit_a_table',
                },
              ],
            },
          },
        },
      ],
    });

    const after = buildValidationInputsSnapshotHash({
      ticketCount: 10,
      factCount: 5,
      precedenceFingerprint: 'precedence-1',
      validationPhase: 'billing_review',
      documentSnapshots: [
        {
          id: 'contract-doc',
          processed_at: '2026-05-27T17:08:00.000Z',
          intelligence_trace: {
            contract_analysis: {
              pricing_model: {
                rate_schedule_present: { value: true },
              },
              rate_schedule_rows: [
                {
                  row_id: 'exhibit_a_table:row-1a',
                  description: 'from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles',
                  unit: 'Cubic Yard',
                  rate: 6.9,
                  page: 8,
                  source_kind: 'exhibit_a_table',
                },
                {
                  row_id: 'exhibit_a_text_recovery:vegetative-rural-0-15-13-50',
                  description: 'from Rural Areas ROW to DMS 0 to 15 Miles',
                  unit: 'Cubic Yard',
                  rate: 13.5,
                  page: 8,
                  source_kind: 'exhibit_a_text_recovery',
                },
              ],
            },
          },
        },
      ],
    });

    assert.notEqual(after, before);
  });

  it('does not skip unchanged inputs when a manual operator trigger is forced', () => {
    assert.equal(
      shouldSkipUnchangedValidationInputs({
        lastCompletedSnapshotHash: 'same-hash',
        inputsSnapshotHash: 'same-hash',
      }),
      true,
    );
    assert.equal(
      shouldSkipUnchangedValidationInputs({
        lastCompletedSnapshotHash: 'same-hash',
        inputsSnapshotHash: 'same-hash',
        force: true,
      }),
      false,
    );
  });
});
