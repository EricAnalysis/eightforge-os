import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { qualificationSourceDigest } from '../qualificationContract';

const HISTORICAL_ENGINE = 'lib/server/valueReadingEngine.ts';
const QUALIFICATION_COMMIT = 'e3ee0c6f21d8175b6d034c32b9c95f5249c56dc2';

/** Verify the frozen registration against its Git source, while other pins still check the current tree. */
export function historicalQualificationSourceDigest(file: string): string {
  const source = file === HISTORICAL_ENGINE
    ? execFileSync('git', ['show', `${QUALIFICATION_COMMIT}:${HISTORICAL_ENGINE}`], { cwd: process.cwd() })
    : readFileSync(file);
  return qualificationSourceDigest(source.toString('utf8'));
}
