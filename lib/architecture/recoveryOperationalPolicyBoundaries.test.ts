import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const POLICY = 'lib/extraction/recovery/recoveryOperationalPolicy.ts';

describe('recovery operational policy architecture boundaries', () => {
  it('cannot accept review, invoke reprocess, call a provider, or access persistence', () => {
    const source = readFileSync(POLICY, 'utf8');
    for (const forbidden of [
      'forgewingRecoveryReview',
      'processDocument',
      'recovery_reprocess',
      'callClaude',
      'getSupabaseAdmin',
      'forgewing_recovery_proposals',
      'forgewing_recovery_reviews',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it('introduces no database-owned recovery policy configuration', () => {
    const migrationText = readdirSync('supabase/migrations')
      .filter((name) => name.endsWith('.sql'))
      .map((name) => readFileSync(path.join('supabase/migrations', name), 'utf8'))
      .join('\n');
    expect(migrationText).not.toMatch(/recovery_operational_policy|recovery_policy_(version|digest)/i);
  });

  it('keeps recovery reprocess Forgewing-provider-free at both orchestration seams', () => {
    const processDocument = readFileSync('lib/pipeline/processDocument.ts', 'utf8');
    const persistence = readFileSync('lib/server/intelligencePersistence.ts', 'utf8');
    expect(processDocument).toContain(
      "const providerWorkAllowed = params.processingPurpose !== 'recovery_reprocess'",
    );
    expect(processDocument).toContain('if (providerWorkAllowed)');
    expect(processDocument).toContain('providerWorkAllowed,');
    expect(persistence).toContain('params.providerWorkAllowed !== false');
    expect(persistence).toContain('scheduleEligiblePricingReasoningShadow({');
  });
});
