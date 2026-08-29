import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(process.cwd(), 'scripts', 'sql', 'measure-pricing-guidance-coverage.sql'),
  'utf8',
);

describe('pricing guidance coverage measurement contract', () => {
  it('tracks every production usable-blob branch before selecting a candidate', () => {
    for (const path of [
      '{extraction,content_layers_v1,pdf,text,pages}',
      '{extraction,content_layers_v1,pdf,evidence}',
      '{extraction,text_preview}',
      '{extraction,evidence_v1,page_text}',
      '{fields,typed_fields}',
      '{extraction,evidence_v1,structured_fields}',
      '{extraction,evidence_v1,section_signals}',
      '{fields,rate_mentions}',
      '{fields,material_mentions}',
      '{fields,scope_mentions}',
      '{fields,compliance_mentions}',
      '{fields,detected_keywords}',
    ]) {
      expect(sql).toContain(path);
    }
    expect(sql).toContain('de.is_usable DESC');
    expect(sql).not.toContain("(de.data #> '{extraction}') IS NOT NULL DESC");
  });

  it('keeps absent containers distinct and fails closed for every malformed declaration', () => {
    expect(sql).toContain("? 'physical_page_provenance_v1'");
    expect(sql).toContain("ELSE 'declared_capture_failed'");
    expect(sql).not.toContain("ELSE 'undeclared_container_paginated'");
  });

  it('remains a read-only measurement', () => {
    expect(sql).not.toMatch(/\b(?:insert|update|delete|merge|create|alter|drop|truncate)\b/i);
  });
});
