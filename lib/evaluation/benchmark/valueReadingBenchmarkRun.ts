import { createHash } from 'node:crypto';

import {
  decideValueReadingActivation,
  scoreValueReading,
  type ValueReadingAttempt,
  type ValueReadingBenchmarkPage,
  type ValueReadingBenchmarkRecord,
  type ValueReadingBenchmarkTarget,
  type ValueReadingDecision,
} from '@/lib/evaluation/benchmark/valueReadingBenchmark';
import type { ValueReadingCropSpec } from '@/lib/server/valueReadingEngine';
import {
  VALUE_READING_EXECUTION,
  type ValueReadingProvider,
  type ValueReadingRegionImage,
} from '@/lib/valueReadingContract';

/**
 * B4.6 run orchestration. Every side effect is injected: rendering, the
 * provider, output parsing, the clock and token usage. The command in
 * scripts/evaluation/b46 wires the production renderer, the production Claude
 * adapter and the production parser, so the benchmark measures exactly what
 * an operator's request would do, minus the database.
 *
 * A dry run renders every target twice (crop determinism and render time) and
 * calls nothing. A provider run refuses to start unless every selected
 * document is recorded as cleared for page-region image transmission, and it
 * stops at hard call and spend ceilings. A run that stops early cannot pass.
 */

export const VALUE_READING_BENCHMARK_CEILINGS = Object.freeze({ maxCalls: 100, maxSpendUsd: 3 });

export type ValueReadingBenchmarkDocument = Readonly<{
  page: ValueReadingBenchmarkPage;
  documentKey: string;
  sourceSha256: string;
  physicalPageNumber: number;
  /** From the recorded clearance: may page-region images of this document be sent to the provider? */
  clearedForPageRegionImages: boolean;
  targets: readonly ValueReadingBenchmarkTarget[];
}>;

export type ParsedReading =
  | Readonly<{ ok: true; reading: Readonly<{ kind: 'value'; rateRow: Readonly<{ description: string; unit_type: string;
      rate_amount: number; category: string | null }> }> | Readonly<{ kind: 'unreadable' }> }>
  | Readonly<{ ok: false; outcomeCode: string; reason: string }>;

export type ValueReadingBenchmarkRunInput = Readonly<{
  mode: 'dry_run' | 'provider_enabled';
  documents: readonly ValueReadingBenchmarkDocument[];
  render: (spec: ValueReadingCropSpec) => Promise<ValueReadingRegionImage | null>;
  provider: ValueReadingProvider | null;
  parse: (raw: string) => ParsedReading;
  /** Tokens recorded since the last take, then reset: one take per provider call, success or failure. */
  takeUsage: () => Readonly<{ inputTokens: number; outputTokens: number }>;
  pricing: Readonly<{ inputUsdPerMillionTokens: number; outputUsdPerMillionTokens: number }> | null;
  ceilings?: Readonly<{ maxCalls: number; maxSpendUsd: number }>;
  now?: () => number;
}>;

export type ValueReadingBenchmarkRunResult = Readonly<{
  mode: ValueReadingBenchmarkRunInput['mode'];
  providerModel: string | null;
  records: readonly ValueReadingBenchmarkRecord[];
  /** Targets whose crop could not be drawn: an evidence failure, never sent. */
  unrendered: readonly Readonly<{ pageKey: string; rowKey: string }>[];
  /** Targets left unread because a ceiling was reached. Non-empty means the run cannot pass. */
  notRun: readonly Readonly<{ pageKey: string; rowKey: string }>[];
  /** What was read for each provider call, kept for human adjudication of disagreements. Client material: local only. */
  readings: readonly Readonly<{ pageKey: string; rowKey: string; attempt: ValueReadingAttempt }>[];
  calls: number;
  spendUsd: number;
  decision: ValueReadingDecision | null;
}>;

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function valueReadingBenchmarkCropSpec(
  document: ValueReadingBenchmarkDocument,
  target: ValueReadingBenchmarkTarget,
): ValueReadingCropSpec {
  return {
    renderer: VALUE_READING_EXECUTION.cropRenderer,
    organizationId: 'benchmark',
    sourceDocumentId: document.documentKey,
    sourceArtifactId: document.sourceSha256,
    physicalPageNumber: document.physicalPageNumber,
    pageRepresentationDigest: document.sourceSha256,
    sourceRegion: { coordinate_space: 'canonical_v1', boxes: target.boxes.map((box) =>
      ({ x_min: box.x_min, x_max: box.x_max, y_min: box.y_min, y_max: box.y_max })) },
    canonicalBoxes: target.boxes,
    scale: VALUE_READING_EXECUTION.cropScale,
    paddingPoints: VALUE_READING_EXECUTION.cropPaddingPoints,
    maxWidthPx: VALUE_READING_EXECUTION.cropMaxWidthPx,
    maxHeightPx: VALUE_READING_EXECUTION.cropMaxHeightPx,
  };
}

async function readWithTimeout(provider: ValueReadingProvider, request: Parameters<ValueReadingProvider['read']>[0]):
  Promise<Readonly<{ ok: true; raw: string } | { ok: false; reason: string }>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('provider_timeout'));
    }, request.timeoutMs);
  });
  try {
    return { ok: true, raw: await Promise.race([provider.read(request, controller.signal), timeout]) };
  } catch (error) {
    const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
    return { ok: false, reason: /timeout|abort/i.test(text) ? 'provider_timeout'
      : /truncat/i.test(text) ? 'provider_truncated_output' : 'provider_error' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runValueReadingBenchmark(input: ValueReadingBenchmarkRunInput): Promise<ValueReadingBenchmarkRunResult> {
  const now = input.now ?? (() => performance.now());
  const ceilings = input.ceilings ?? VALUE_READING_BENCHMARK_CEILINGS;
  if (ceilings.maxCalls > VALUE_READING_BENCHMARK_CEILINGS.maxCalls
    || ceilings.maxSpendUsd > VALUE_READING_BENCHMARK_CEILINGS.maxSpendUsd) {
    throw new Error('Benchmark ceilings may be lowered, never raised');
  }
  const live = input.mode === 'provider_enabled';
  if (live) {
    // Nothing is sent for a document whose transmission is not recorded as cleared.
    const uncleared = input.documents.filter((document) => !document.clearedForPageRegionImages);
    if (uncleared.length > 0) {
      throw new Error(`Not cleared for page-region image transmission: ${uncleared.map((document) => document.documentKey).join(', ')}`);
    }
    if (!input.provider?.providerModel) throw new Error('A provider run needs a provider with a model');
    if (!input.pricing || !(input.pricing.inputUsdPerMillionTokens > 0) || !(input.pricing.outputUsdPerMillionTokens > 0)) {
      throw new Error('A provider run needs confirmed per-token prices');
    }
  }

  const records: ValueReadingBenchmarkRecord[] = [];
  const unrendered: { pageKey: string; rowKey: string }[] = [];
  const notRun: { pageKey: string; rowKey: string }[] = [];
  const readings: { pageKey: string; rowKey: string; attempt: ValueReadingAttempt }[] = [];
  let calls = 0;
  let spendUsd = 0;
  for (const document of input.documents) {
    for (const target of document.targets) {
      const spec = valueReadingBenchmarkCropSpec(document, target);
      const renderStart = now();
      const image = await input.render(spec);
      const renderMs = now() - renderStart;
      if (!image || image.mediaType !== 'image/png' || image.bytes.byteLength === 0) {
        unrendered.push({ pageKey: target.pageKey, rowKey: target.rowKey });
        continue;
      }
      const renderDigestSha256 = sha256(image.bytes);
      // A repeat ask is answered from the stored proposal only if the same bytes come back.
      const again = await input.render(spec);
      const reuseEligible = Boolean(again && sha256(again.bytes) === renderDigestSha256);
      const base = { pageKey: target.pageKey, evidenceClass: target.evidenceClass, rowKey: target.rowKey,
        renderMs, renderDigestSha256, reuseEligible };
      if (!live) {
        records.push({ ...base, outcome: 'failed', fields: null, providerMs: 0, totalMs: renderMs,
          inputTokens: 0, outputTokens: 0, usd: 0 });
        continue;
      }
      if (calls + 1 > ceilings.maxCalls || spendUsd >= ceilings.maxSpendUsd) {
        notRun.push({ pageKey: target.pageKey, rowKey: target.rowKey });
        continue;
      }
      calls += 1;
      input.takeUsage();
      const providerStart = now();
      const called = await readWithTimeout(input.provider!, {
        requestDigestSha256: sha256(new TextEncoder().encode(`b46:${target.pageKey}:${target.rowKey}:${renderDigestSha256}`)),
        renderDigestSha256,
        model: input.provider!.providerModel,
        timeoutMs: VALUE_READING_EXECUTION.timeoutMs,
        maxOutputTokens: VALUE_READING_EXECUTION.maxOutputTokens,
        promptTemplateId: VALUE_READING_EXECUTION.promptTemplateId,
        promptTemplateVersion: VALUE_READING_EXECUTION.promptTemplateVersion,
        outputSchemaVersion: VALUE_READING_EXECUTION.outputSchemaVersion,
        image,
        // The production Ask route sends no text excerpts; neither does the benchmark.
        textExcerpts: null,
      });
      const providerMs = now() - providerStart;
      const usage = input.takeUsage();
      const usd = (usage.inputTokens * input.pricing!.inputUsdPerMillionTokens
        + usage.outputTokens * input.pricing!.outputUsdPerMillionTokens) / 1_000_000;
      spendUsd += usd;
      let attempt: ValueReadingAttempt;
      if (!called.ok) attempt = { kind: 'failed', code: 'provider_failed', reason: called.reason };
      else {
        const parsed = input.parse(called.raw);
        attempt = parsed.ok ? parsed.reading : { kind: 'failed', code: parsed.outcomeCode, reason: parsed.reason };
      }
      readings.push({ pageKey: target.pageKey, rowKey: target.rowKey, attempt });
      const score = scoreValueReading(target.truth, attempt);
      records.push({ ...base, outcome: score.outcome, fields: score.fields, providerMs, totalMs: renderMs + providerMs,
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, usd });
    }
  }
  return {
    mode: input.mode,
    providerModel: live ? input.provider!.providerModel : null,
    records,
    unrendered,
    notRun,
    readings,
    calls,
    spendUsd,
    // Only a complete provider run is decided. Unrendered targets count against the run as failures.
    decision: live && notRun.length === 0 ? decideValueReadingActivation([...records,
      ...unrendered.map((entry) => {
        const target = input.documents.flatMap((document) => document.targets)
          .find((candidate) => candidate.pageKey === entry.pageKey && candidate.rowKey === entry.rowKey)!;
        return { pageKey: entry.pageKey, evidenceClass: target.evidenceClass, rowKey: entry.rowKey, outcome: 'failed' as const,
          fields: null, renderMs: 0, providerMs: 0, totalMs: 0, inputTokens: 0, outputTokens: 0, usd: 0,
          renderDigestSha256: '', reuseEligible: false };
      })]) : null,
  };
}
