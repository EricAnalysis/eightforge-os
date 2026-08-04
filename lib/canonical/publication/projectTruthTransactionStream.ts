import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';

import type { CanonicalTransaction } from '@/lib/canonical/transaction/transaction';
import {
  adaptProjectTransactionRow,
  type PersistedCanonicalTransactionRowInput,
} from '@/lib/canonical/transaction/transactionAdapter';
import type { SourceArtifactSnapshotEntry } from './projectTruthPublication';
import { canonicalJson } from './projectTruthPublicationIdentity';

export type PreparedCanonicalTransactionStream = {
  readonly count: number;
  readonly digest: string;
  readonly createGzipStream: () => {
    readonly stream: Readable;
    readonly verification: Promise<{ readonly count: number; readonly digest: string }>;
  };
};

function rowOrderKey(row: PersistedCanonicalTransactionRowInput): string {
  return [
    row.id ?? '', row.document_id ?? '', row.source_sheet_name ?? '',
    row.source_row_number == null ? '' : String(row.source_row_number).padStart(12, '0'),
    row.transaction_number ?? '',
  ].join('\u0000');
}

function orderedRows(rows: readonly PersistedCanonicalTransactionRowInput[]): readonly PersistedCanonicalTransactionRowInput[] {
  return [...rows].sort((left, right) => rowOrderKey(left).localeCompare(rowOrderKey(right), 'en-US'));
}

function sourceArtifactByDocument(
  snapshot: readonly SourceArtifactSnapshotEntry[],
): ReadonlyMap<string, SourceArtifactSnapshotEntry> {
  return new Map([...snapshot]
    .sort((left, right) => left.documentId.localeCompare(right.documentId, 'en-US'))
    .map((entry) => [entry.documentId, entry]));
}

export function adaptCanonicalTransactionRow(
  row: PersistedCanonicalTransactionRowInput,
  artifacts: ReadonlyMap<string, SourceArtifactSnapshotEntry>,
): CanonicalTransaction {
  const artifact = row.document_id ? artifacts.get(row.document_id) : undefined;
  return adaptProjectTransactionRow(row, {
    documentId: row.document_id ?? null,
    sourceWorkbook: artifact?.storagePath ?? null,
  });
}

function canonicalTransactionLine(
  row: PersistedCanonicalTransactionRowInput,
  artifacts: ReadonlyMap<string, SourceArtifactSnapshotEntry>,
): string {
  return `${canonicalJson(adaptCanonicalTransactionRow(row, artifacts))}\n`;
}

/**
 * Pass one hashes an ordered stream one row at a time. Each call to
 * `createGzipStream` performs pass two from the same ordering and verifies that
 * its uncompressed records match pass one. No transaction line array or whole
 * registry serialization is retained.
 */
export function prepareCanonicalTransactionStream(input: {
  readonly rows: readonly PersistedCanonicalTransactionRowInput[];
  readonly sourceArtifacts: readonly SourceArtifactSnapshotEntry[];
}): PreparedCanonicalTransactionStream {
  const rows = orderedRows(input.rows);
  const artifacts = sourceArtifactByDocument(input.sourceArtifacts);
  const firstHash = createHash('sha256');
  let firstCount = 0;
  for (const row of rows) {
    firstHash.update(canonicalTransactionLine(row, artifacts));
    firstCount += 1;
  }
  const digest = firstHash.digest('hex');

  return {
    count: firstCount,
    digest,
    createGzipStream: () => {
      let resolveVerification!: (value: { readonly count: number; readonly digest: string }) => void;
      let rejectVerification!: (reason: unknown) => void;
      const verification = new Promise<{ readonly count: number; readonly digest: string }>((resolve, reject) => {
        resolveVerification = resolve;
        rejectVerification = reject;
      });
      async function* lines(): AsyncGenerator<string> {
        const secondHash = createHash('sha256');
        let secondCount = 0;
        try {
          for (const row of rows) {
            const line = canonicalTransactionLine(row, artifacts);
            secondHash.update(line);
            secondCount += 1;
            yield line;
          }
          const secondDigest = secondHash.digest('hex');
          if (secondCount !== firstCount || secondDigest !== digest) {
            throw new Error('Canonical transaction digest and upload passes diverged');
          }
          resolveVerification({ count: secondCount, digest: secondDigest });
        } catch (error) {
          rejectVerification(error);
          throw error;
        }
      }
      const stream = Readable.from(lines()).pipe(createGzip({ level: 9 }));
      return { stream, verification };
    },
  };
}
