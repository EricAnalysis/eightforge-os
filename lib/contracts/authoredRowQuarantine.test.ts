import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  authoredRateRowQuarantine,
  isAuthoredUnverifiedRateRow,
} from '@/lib/contracts/authoredRowQuarantine';

describe('authored rate-row quarantine classification', () => {
  it('classifies F-01 through F-03 by source kind or row-id prefix', () => {
    assert.equal(
      authoredRateRowQuarantine({
        source_kind: 'tdot_appendix_b_stitched_table',
      })?.finding,
      'F-01',
    );
    assert.equal(
      authoredRateRowQuarantine({
        row_id: 'tdot_appendix_b_stitched:page-1:row-1',
      })?.finding,
      'F-01',
    );
    assert.equal(
      authoredRateRowQuarantine({
        sourceKind: 'mdot_section_905_bid_schedule',
      })?.finding,
      'F-02',
    );
    assert.equal(
      authoredRateRowQuarantine({
        id: 'mdot_section_905_bid_schedule:page-1:row-1',
      })?.finding,
      'F-02',
    );
    assert.equal(
      authoredRateRowQuarantine({
        source_kind: 'exhibit_a_text_recovery',
      })?.finding,
      'F-03',
    );
    assert.equal(
      authoredRateRowQuarantine({
        row_id: 'exhibit_a_text_recovery:page-1:row-1',
      })?.finding,
      'F-03',
    );
  });

  it('classifies Williamson corrections only through the explicit authored flag', () => {
    assert.equal(
      authoredRateRowQuarantine({
        source_kind: 'exhibit_a_table',
        authoredValueCorrection: true,
      })?.finding,
      'F-04',
    );
    assert.equal(
      isAuthoredUnverifiedRateRow({
        source_kind: 'exhibit_a_table',
        authoredValueCorrection: false,
      }),
      false,
    );
  });

  it('leaves legitimate and generic rate-row sources unaffected', () => {
    for (const source_kind of [
      'exhibit_a_table',
      'structural_table',
      'professional_services_table',
      'rate_schedule',
      'canonical',
    ]) {
      assert.equal(
        isAuthoredUnverifiedRateRow({ source_kind }),
        false,
        source_kind,
      );
    }
  });
});
