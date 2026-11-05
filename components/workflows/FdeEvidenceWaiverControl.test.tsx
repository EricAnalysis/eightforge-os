import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { FdeEvidenceWaiverControl, EMPTY_FDE_WAIVER, canSubmitFdeWaiver } from './FdeEvidenceWaiverControl';

const acknowledgment = 'I acknowledge that this information has not been independently verified.';
const sources = [{ id: 'customer-intake', label: 'Customer intake' }];

describe('FDE evidence waiver control', () => {
  it('starts off and does not present an acknowledgment as already accepted', () => {
    const html = renderToStaticMarkup(<FdeEvidenceWaiverControl value={EMPTY_FDE_WAIVER}
      acknowledgmentText={acknowledgment} sources={sources} onChange={() => undefined} />);
    expect(html).toContain('Proceed without supporting documents');
    expect(html).not.toContain('checked=""');
    expect(html).not.toContain(acknowledgment);
    expect(canSubmitFdeWaiver(EMPTY_FDE_WAIVER)).toBe(false);
  });

  it('requires an explicit acknowledgment, statement, reason, and source', () => {
    const enabled = { ...EMPTY_FDE_WAIVER, enabled: true, customerStatement: 'Customer says the schedule is current',
      reason: 'The document is unavailable', sourceId: 'customer-intake' };
    const html = renderToStaticMarkup(<FdeEvidenceWaiverControl value={enabled}
      acknowledgmentText={acknowledgment} sources={sources} onChange={() => undefined} />);
    expect(html).toContain(acknowledgment);
    expect(html.match(/checked=""/g)).toHaveLength(1); // The toggle is on; the acknowledgment is not.
    expect(canSubmitFdeWaiver(enabled)).toBe(false);
    expect(canSubmitFdeWaiver({ ...enabled, acknowledged: true })).toBe(true);
    expect(canSubmitFdeWaiver({ ...enabled, acknowledged: true, sourceId: '' })).toBe(false);
  });
});
