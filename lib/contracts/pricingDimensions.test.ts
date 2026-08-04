import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';

import {
  parseAuthoredPricingDimensions,
  pricingDistanceDisplayLabel,
  pricingDistanceMatchingKey,
  pricingRouteDisplayLabel,
  pricingRouteMatchingKey,
} from '@/lib/contracts/pricingDimensions';

describe('pricing dimensions', () => {
  it.each([
    ['ROW to DMS', 'row_to_dms'], ['ROW → DMS', 'row_to_dms'],
    ['ROWtoDMS', 'row_to_dms'], ['ROW t6 DMS', 'row_to_dms'], ['ROW 10 DMS', 'row_to_dms'],
    ['DMS to final disposal', 'dms_to_final_disposal'], ['DMS to FDS', 'dms_to_final_disposal'],
    ['ROW to final disposal', 'row_to_final_disposal'],
    ['12 miles from ROW to DMS', 'row_to_dms'],
  ] as const)('parses route alias %s', (source, expected) => {
    const parsed = parseAuthoredPricingDimensions(source);
    assert.equal(parsed.routeKind, expected);
    assert.ok(parsed.routeRawSpan);
    assert.equal(parsed.confidence, null);
  });

  it.each([
    ['0 to 15 Miles', 0, 15, false], ['0–15 Miles', 0, 15, false],
    ['0-15 Miles', 0, 15, false], ['16 to 30 Miles', 16, 30, false],
    ['31 to 60 Miles', 31, 60, false], ['60+ Miles', 60, null, true],
    ['over 60 Miles', 60, null, true], ['up to 15 Miles', 0, 15, false],
    ['0  to   15  Milas', 0, 15, false],
  ] as const)('parses distance expression %s', (source, min, max, openEnded) => {
    const parsed = parseAuthoredPricingDimensions(source);
    assert.equal(parsed.distanceBand?.minMiles, min);
    assert.equal(parsed.distanceBand?.maxMiles, max);
    assert.equal(parsed.distanceBand?.openEnded, openEnded);
    assert.ok(parsed.distanceRawSpan);
  });

  it('keeps conflicting routes and distances ambiguous', () => {
    const routes = parseAuthoredPricingDimensions('ROW to DMS or DMS to final disposal');
    assert.equal(routes.routeKind, 'unresolved');
    assert.equal(routes.parseState, 'ambiguous');
    const distances = parseAuthoredPricingDimensions('0 to 15 Miles or 16 to 30 Miles');
    assert.equal(distances.distanceBand, null);
    assert.equal(distances.parseState, 'ambiguous');
  });

  it('produces stable matching keys and compatibility display labels', () => {
    const parsed = parseAuthoredPricingDimensions('ROW → DMS, 60+ Miles');
    assert.equal(pricingRouteMatchingKey(parsed), 'row_to_dms');
    assert.equal(pricingDistanceMatchingKey(parsed.distanceBand), 'miles:60:*');
    assert.equal(pricingRouteDisplayLabel(parsed.routeKind, parsed.routeRawSpan), 'ROW to DMS');
    assert.equal(pricingDistanceDisplayLabel(parsed.distanceBand), '60+ Miles');
  });

  it('preserves exact authored spans while tolerating OCR spelling', () => {
    const parsed = parseAuthoredPricingDimensions('  ROWt6DMS  0\u201315 Milas  ');
    assert.equal(parsed.routeRawSpan, 'ROWt6DMS');
    assert.equal(parsed.distanceRawSpan, '0\u201315 Milas');
  });

  it('contains no source-family or fixture-specific behavior', () => {
    const parserSource = readFileSync('lib/contracts/pricingDimensions.ts', 'utf8');
    assert.doesNotMatch(parserSource, /Golden|TDOT|MDOT|Goodlettsville|Williamson|fixture|contractor|documentId|pageNumber/i);
  });
});
