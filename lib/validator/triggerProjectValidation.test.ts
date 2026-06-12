import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  buildValidationInputsSnapshotHash,
  shouldSkipUnchangedValidationInputs,
} from '@/lib/validator/triggerProjectValidation';

describe('validation trigger input fingerprint', () => {
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
