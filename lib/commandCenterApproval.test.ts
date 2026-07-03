import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildCanonicalApprovalByProjectId,
  canonicalApprovalForProject,
} from './commandCenterApproval';

describe('canonicalApprovalForProject', () => {
  it('marks a project blocked from canonical validator blockers', () => {
    const approval = canonicalApprovalForProject({
      validation_status: 'BLOCKED',
      validation_summary_json: {
        readiness: 'BLOCKED',
        blocker_count: 1,
        critical_count: 1,
        open_count: 9,
        validator_blockers: [
          {
            rule_id: 'FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT',
            severity: 'critical',
            subject_id: 'fact:doc:line:6',
          },
        ],
      },
    });

    assert.equal(approval.label, 'Blocked');
    assert.equal(approval.blocker_count, 1);
    assert.equal(approval.is_blocked, true);
  });

  it('does not mark a project blocked when readiness is READY with no blockers', () => {
    const approval = canonicalApprovalForProject({
      validation_status: 'VALIDATED',
      validation_summary_json: {
        readiness: 'READY',
        validator_status: 'READY',
        blocker_count: 0,
        critical_count: 0,
        open_count: 0,
        validator_blockers: [],
      },
    });

    assert.equal(approval.label, 'Approved');
    assert.equal(approval.blocker_count, 0);
    assert.equal(approval.is_blocked, false);
  });

  it('keeps non-blocking review findings out of the blocked state', () => {
    const approval = canonicalApprovalForProject({
      validation_status: 'FINDINGS_OPEN',
      validation_summary_json: {
        readiness: 'NEEDS_REVIEW',
        validator_status: 'NEEDS_REVIEW',
        blocker_count: 0,
        critical_count: 0,
        warning_count: 2,
        open_count: 2,
        validator_blockers: [],
      },
    });

    assert.equal(approval.label, 'Needs Review');
    assert.equal(approval.blocker_count, 0);
    assert.equal(approval.is_blocked, false);
  });

  it('treats a project without a persisted summary as not evaluated and not blocked', () => {
    const approval = canonicalApprovalForProject({
      validation_status: null,
      validation_summary_json: null,
    });

    assert.equal(approval.label, 'Not Evaluated');
    assert.equal(approval.is_blocked, false);
  });
});

describe('buildCanonicalApprovalByProjectId', () => {
  it('maps each project id to its canonical approval', () => {
    const map = buildCanonicalApprovalByProjectId([
      {
        id: 'blocked-project',
        validation_status: 'BLOCKED',
        validation_summary_json: {
          readiness: 'BLOCKED',
          blocker_count: 2,
          critical_count: 2,
          open_count: 5,
          validator_blockers: [
            { rule_id: 'RULE_A', severity: 'critical', subject_id: 's1' },
            { rule_id: 'RULE_B', severity: 'critical', subject_id: 's2' },
          ],
        },
      },
      {
        id: 'clean-project',
        validation_status: 'VALIDATED',
        validation_summary_json: {
          readiness: 'READY',
          validator_status: 'READY',
          blocker_count: 0,
          critical_count: 0,
          open_count: 0,
          validator_blockers: [],
        },
      },
    ]);

    assert.equal(map.get('blocked-project')?.is_blocked, true);
    assert.equal(map.get('blocked-project')?.blocker_count, 2);
    assert.equal(map.get('clean-project')?.is_blocked, false);
  });
});
