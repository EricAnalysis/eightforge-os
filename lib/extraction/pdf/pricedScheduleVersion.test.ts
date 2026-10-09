import { describe, expect, it } from 'vitest';
import { buildPagePricedScheduleReconstruction } from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';
import { isPagePricedScheduleVersion, isSupportedPricedScheduleVersion } from '@/lib/extraction/pdf/pricedScheduleVersion';

describe('priced-schedule parser compatibility', () => {
  it('versions new production output while explicit frozen recovery retains v1', () => {
    const layout = { page_count: 0, pages: [], gaps: [] };
    expect(buildPagePricedScheduleReconstruction({ layout })).toEqual({ parser_version: 'priced_schedule_reconstruction_v5', pages: [] });
    expect(buildPagePricedScheduleReconstruction({ layout, continuationEvidence: 'spacing_only' }))
      .toEqual({ parser_version: 'priced_schedule_reconstruction_v1', pages: [] });
  });
  it('accepts only the reviewed parser identifiers; stored v2 through v4 stay supported after v5', () => {
    expect(isSupportedPricedScheduleVersion('priced_schedule_reconstruction_v1')).toBe(true);
    expect(isSupportedPricedScheduleVersion('priced_schedule_reconstruction_v2')).toBe(true);
    expect(isSupportedPricedScheduleVersion('priced_schedule_reconstruction_v3')).toBe(true);
    expect(isSupportedPricedScheduleVersion('priced_schedule_reconstruction_v4')).toBe(true);
    expect(isSupportedPricedScheduleVersion('priced_schedule_reconstruction_v5')).toBe(true);
    expect(isPagePricedScheduleVersion('priced_schedule_reconstruction_v1')).toBe(false);
    expect(isPagePricedScheduleVersion('priced_schedule_reconstruction_v2')).toBe(true);
    expect(isPagePricedScheduleVersion('priced_schedule_reconstruction_v3')).toBe(true);
    expect(isPagePricedScheduleVersion('priced_schedule_reconstruction_v4')).toBe(true);
    expect(isPagePricedScheduleVersion('priced_schedule_reconstruction_v5')).toBe(true);
    for (const value of [undefined, null, '', 'priced_schedule_reconstruction_v999', { parser_version: 'priced_schedule_reconstruction_v2' }])
      expect(isSupportedPricedScheduleVersion(value)).toBe(false);
  });
});
