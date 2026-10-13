import { describe, expect, it } from 'vitest';

import { getClaudeSamplingParameters } from '@/lib/server/ai/claudeSampling';

describe('Claude sampling parameters', () => {
  it('preserves the Sonnet 4.6 rollback request contract', () => {
    expect(getClaudeSamplingParameters('claude-sonnet-4-6')).toEqual({ temperature: 0 });
  });

  it('omits rejected sampling parameters for Claude 5 and later contracts', () => {
    expect(getClaudeSamplingParameters('claude-sonnet-5')).toEqual({});
    expect(getClaudeSamplingParameters('claude-sonnet-5-5')).toEqual({});
    expect(getClaudeSamplingParameters('claude-opus-4-7')).toEqual({});
  });
});
