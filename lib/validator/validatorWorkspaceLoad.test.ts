import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  buildCanonicalTransactionSummaryFromRows,
  resolveCanonicalProjectValidatorWorkspace,
} from '@/lib/projectFacts';
import { resolveLoadedValidatorWorkspace } from '@/lib/validator/validatorWorkspaceLoad';

describe('resolveLoadedValidatorWorkspace', () => {
  it('skips provisional output and preserves the final Golden-shaped canonical workspace', () => {
    const rows = Array.from({ length: 5063 }, (_, index) => ({
      id: `golden-row-${index + 1}`,
      document_id: 'golden-transactions',
      invoice_number: '2026-002',
      transaction_number: `T-${index + 1}`,
      transaction_quantity: 1,
      extended_cost: index === 0 ? 815559.35 : null,
      source_sheet_name: 'Tickets',
      source_row_number: index + 2,
    }));
    const finalInputs = {
      validationStatus: 'FINDINGS_OPEN',
      validationSummary: {
        validation_phase: 'billing_review',
        open_count: 8,
        critical_count: 1,
        warning_count: 7,
        blocker_count: 1,
        total_billed: 815559.35,
        unsupported_amount: 0,
        validator_open_items: [{ id: 'golden-rate-code-finding' }],
      },
      documents: [
        {
          id: 'golden-contract',
          title: 'Golden Project Governing Contract',
          name: 'Golden Project Governing Contract.pdf',
          document_type: 'contract',
          document_role: 'governing_contract',
          authority_status: 'governing',
        },
        {
          id: 'golden-invoice',
          title: 'Invoice 2026-002',
          name: 'Invoice 2026-002.pdf',
          document_type: 'invoice',
        },
      ],
      transactionDatasets: [
        {
          document_id: 'golden-transactions',
          row_count: 5063,
          date_range_start: '2026-01-01',
          date_range_end: '2026-01-31',
          created_at: '2026-01-31T00:00:00.000Z',
          summary_json: {
            project_operations_overview: {
              total_tickets: 74617,
              total_invoiced_amount: 815559.35,
            },
          },
          rows,
        },
      ],
    } as const;

    const oldPathFinalWorkspace = resolveCanonicalProjectValidatorWorkspace(finalInputs);
    const newPathFinalWorkspace = resolveLoadedValidatorWorkspace(false, {
      ...finalInputs,
      precomputed: buildCanonicalTransactionSummaryFromRows(rows),
    });

    assert.equal(resolveLoadedValidatorWorkspace(true, finalInputs), null);
    assert.deepEqual(newPathFinalWorkspace, oldPathFinalWorkspace);
  });
});
