import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { buildForgewingLabelAttestationTemplate } from
  '@/lib/evaluation/forgewing/labelledPricingAttestation';

export function generateForgewingLabelAttestationTemplate(params: {
  ledgerPath: string;
  outputPath: string;
}): string {
  const ledgerPath = resolve(params.ledgerPath);
  const outputPath = resolve(params.outputPath);
  const template = buildForgewingLabelAttestationTemplate({
    ledgerBytes: readFileSync(ledgerPath),
  });
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(template, null, 2)}\n`, 'utf8');
  return outputPath;
}

export function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: { ledger: { type: 'string' }, output: { type: 'string' } },
  });
  if (!values.ledger || !values.output) {
    throw new Error('forgewing_label_attestation_template_missing_required_argument');
  }
  process.stdout.write(`${generateForgewingLabelAttestationTemplate({
    ledgerPath: values.ledger,
    outputPath: values.output,
  })}\n`);
}

if (process.env.FORGEWING_LABEL_ATTESTATION_TEMPLATE_CLI === '1'
  || process.argv.some((value) => value.replaceAll('\\', '/')
  .endsWith('generateForgewingLabelAttestationTemplate.ts'))) {
  main();
}
