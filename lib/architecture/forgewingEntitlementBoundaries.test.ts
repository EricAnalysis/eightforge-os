import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * EightForge Core vs Core + Forgewing. Both tiers share one canonical truth model.
 * The organization entitlement may gate Forgewing (AI) work only. It must never
 * shape deterministic extraction, canonical truth, or the Validator.
 */

const ENTITLEMENT_MODULE = 'lib/server/forgewingEntitlement.ts';
const COMPLIANCE_SHADOW = 'lib/extraction/persistence/complianceShadow.ts';
const INTELLIGENCE_PERSISTENCE = 'lib/server/intelligencePersistence.ts';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

describe('organization Forgewing entitlement boundaries', () => {
  it('gates the region-classification wrapper through the entitlement, and nowhere else wraps it', () => {
    const source = readFileSync(COMPLIANCE_SHADOW, 'utf8');
    expect(source).toContain('step3InterpretationBridge: step3BridgeForForgewingEntitlement(');
    expect(source).toContain('?? resolveForgewingEntitlement)(');
    // Customer text leaves only under an approved text_excerpts data policy (D2).
    const bridge = source.slice(source.indexOf('step3InterpretationBridge: step3BridgeForForgewingEntitlement('));
    expect(bridge.slice(0, bridge.indexOf('input.organizationId,\n            input.sourceDocumentId'))).toMatch(
      /resolveForgewingDataPolicy\)\(input\.admin, \{\s*organizationId: input\.organizationId, provider: 'anthropic', contentClasses: \['text_excerpts'\],\s*\}\)\)\.approved/);
    // One definition, plus one call inside the entitlement helper.
    expect(source.match(/withForgewingRegionClassificationShadow\(/g)).toHaveLength(2);
  });

  it('gates Forgewing pricing and recovery scheduling behind the entitlement', () => {
    const source = readFileSync(INTELLIGENCE_PERSISTENCE, 'utf8');
    const guard = source.indexOf('params.resolveForgewingEntitlement ?? resolveForgewingEntitlement');
    const schedule = source.indexOf('scheduleEligiblePricingReasoningShadow({');
    expect(guard).toBeGreaterThan(-1);
    expect(schedule).toBeGreaterThan(guard);
    // The guard sits in the same condition that already withholds provider
    // work for recovery reprocess.
    const condition = source.slice(source.lastIndexOf('if (', guard), schedule);
    expect(condition).toContain('params.providerWorkAllowed !== false');
    expect(condition).toContain('.entitled');
    expect(condition).toMatch(/resolveForgewingDataPolicy\)\(params\.admin, \{\s*organizationId: params\.organizationId, provider: 'anthropic', contentClasses: \['text_excerpts'\],\s*\}\)\)\.approved/);
  });

  it('never lets the entitlement shape deterministic extraction, canonical truth, or the Validator', () => {
    const coreFiles = [
      'lib/server/documentExtraction.ts',
      ...walk('lib/canonical'),
      ...walk('lib/validator'),
      ...walk('lib/contracts'),
      ...walk('lib/extraction/pdf'),
    ];
    for (const file of coreFiles) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/forgewingEntitlement|resolveForgewingEntitlement|organization_forgewing_entitlement/);
    }
  });

  it('keeps the resolver free of Forgewing tasks, providers, and write access', () => {
    const source = readFileSync(ENTITLEMENT_MODULE, 'utf8');
    for (const forbidden of ['@/lib/forgewing', 'getClaudeClient', '.insert(', '.update(', '.delete(', '.upsert(']) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });
});
