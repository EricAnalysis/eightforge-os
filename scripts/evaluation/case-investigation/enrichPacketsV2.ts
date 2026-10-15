/**
 * Case Investigation contract v2: source-enriched reviewer packets (owner
 * decision 2026-10-15). Explicit, manual command. ZERO provider calls.
 *
 *   npx vite-node --config vitest.config.ts scripts/evaluation/case-investigation/enrichPacketsV2.ts -- \
 *     --corpus <corpus dir> --cases <json array of {caseRef, caseId}> --out <packets.jsonl> \
 *     --index <repo-safe index.json> --env-file <.env with production read access>
 *
 * The phase-1 reviewers could not tell "value absent from the source" from
 * "EightForge failed to read it". Each packet now adds, for the case's EXACT
 * cited source documents (evidence rows, or a decision's own document), and
 * nothing else:
 *   - document type and extraction coverage (pages with text, characters,
 *     extraction gaps), read from the same preferred extraction the product
 *     uses;
 *   - bounded excerpts: the cited page when one is cited, otherwise windows
 *     around the case rule's own terms inside the cited document (at most 5 x
 *     500 characters per document), with an explicit hit count, so "0 hits in
 *     an extracted document" and "no text extracted" are both visible.
 * Conflict fixtures carry their fixture source rows instead (their source by
 * construction). Production is read through readOnlyClient. Customer text is
 * written only to --out (outside the repository); --index holds ids, pages,
 * counts and digests only.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createClient } from '@supabase/supabase-js';

import { pickPreferredExtractionBlob } from '@/lib/blobExtractionSelection';
import { CONFLICT_FIXTURE_PROJECTS } from '@/lib/evaluation/caseInvestigation/conflictFixtures';
import { readOnlyClient } from '@/lib/evaluation/caseInvestigation/readClients';

const MAX_WINDOWS = 5;
const WINDOW = 250;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };

/** The terms each rule's question turns on. Rule-level, never case-specific. */
const RULE_TERMS: ReadonlyArray<readonly [RegExp, RegExp]> = [
  [/ceiling|NTE_FACT/u, /not[\s-]+to[\s-]+exceed|\bNTE\b|ceiling|maximum (?:contract )?(?:amount|value|sum|price)|total contract (?:amount|value|price|sum)|contract (?:amount|sum|price|value)|shall not exceed/iu],
  [/contractor/u, /\bcontractor\b|\bvendor\b|\bconsultant\b|\bLLC\b|\bInc\b\.?|\bCorp(?:oration)?\b|\bCompany\b|by and between/iu],
  [/rate_schedule|RATE_BASED|RATE_SCHEDULE|pricing_applicability/u, /unit price|rate schedule|price schedule|schedule of (?:rates|values|prices)|exhibit|bid (?:form|tab|schedule)|per (?:cubic yard|ton|hour|load|mile|each)|\$\s?\d/iu],
  [/invoice_support/u, /\bticket|\bload\b|back[\s-]?up|supporting|attached|manifest|haul log/iu],
  [/TRANSACTION_GROUP|BILLING_KEY|TOTAL_RECONCILES|INVOICE_LINE/u, /\btotal\b|amount due|subtotal|\bqty\b|quantity|unit price|line/iu],
  [/fema|trigger|documentation_prerequisite|derived_value/u, /FEMA|reimburs|trigger|condition|documentation|prerequisite|activat|notice to proceed|task order/iu],
];
const termsFor = (ruleId: string) => RULE_TERMS.find(([rule]) => rule.test(ruleId))?.[1] ?? /\S/u;

type PdfText = { pages?: Array<{ page_number?: number; plain_text_blocks?: Array<Record<string, unknown>> }>;
  page_count?: number; combined_text?: string; gaps?: Array<{ category?: string; message?: string }> };

function pageTexts(data: Record<string, unknown> | null): Array<{ page: number; text: string }> {
  const pdf = ((data?.extraction as Record<string, unknown> | undefined)?.content_layers_v1 as Record<string, unknown> | undefined)
    ?.pdf as Record<string, unknown> | undefined;
  const text = pdf?.text as PdfText | undefined;
  return (text?.pages ?? []).map((page) => ({
    page: Number(page.page_number ?? 0),
    text: (page.plain_text_blocks ?? []).map((block) => String(block.text ?? '')).join('\n'),
  }));
}

function coverage(data: Record<string, unknown> | null, pages: Array<{ page: number; text: string }>) {
  const pdf = ((data?.extraction as Record<string, unknown> | undefined)?.content_layers_v1 as Record<string, unknown> | undefined)
    ?.pdf as Record<string, unknown> | undefined;
  const text = pdf?.text as PdfText | undefined;
  const metadata = (data?.extraction as Record<string, unknown> | undefined)?.metadata as Record<string, unknown> | undefined;
  return {
    extractionFound: data != null,
    pageCount: text?.page_count ?? null,
    pagesWithText: pages.filter((page) => page.text.trim().length > 0).length,
    extractedCharacters: pages.reduce((sum, page) => sum + page.text.replace(/\s+/gu, '').length, 0),
    ocrPagesAttempted: typeof metadata?.ocr_pages_attempted === 'number' ? metadata.ocr_pages_attempted : null,
    extractionGaps: (text?.gaps ?? []).map((gap) => ({ category: gap.category ?? null, message: gap.message ?? null })),
  };
}

function windows(pages: Array<{ page: number; text: string }>, terms: RegExp, citedPage: number | null) {
  const scoped = citedPage != null ? pages.filter((page) => page.page === citedPage) : pages;
  let hits = 0;
  const out: Array<{ page: number; excerpt: string }> = [];
  for (const page of scoped) {
    const global = new RegExp(terms.source, terms.flags.includes('g') ? terms.flags : `${terms.flags}g`);
    for (const match of page.text.matchAll(global)) {
      hits += 1;
      if (out.length >= MAX_WINDOWS) continue;
      const start = Math.max(0, (match.index ?? 0) - WINDOW);
      const excerpt = page.text.slice(start, (match.index ?? 0) + WINDOW).replace(/\s+/gu, ' ').trim();
      if (!out.some((existing) => existing.page === page.page && existing.excerpt === excerpt)) out.push({ page: page.page, excerpt });
    }
  }
  if (citedPage != null && out.length === 0 && scoped[0]) {
    out.push({ page: scoped[0].page, excerpt: scoped[0].text.slice(0, 2 * WINDOW).replace(/\s+/gu, ' ').trim() });
  }
  return { termHits: hits, excerpts: out };
}

function fixtureRows(resolutionCase: Record<string, unknown>) {
  const subject = String((resolutionCase.finding as Record<string, unknown> | undefined)?.checkKey ?? '');
  const ticket = /:ticket:[^:]+:([^:]+):/u.exec(subject)?.[1] ?? null;
  const invoice = /invoice-number:([^:]+)/u.exec(subject)?.[1] ?? null;
  for (const project of CONFLICT_FIXTURE_PROJECTS) {
    const tx = (project.transactions ?? []).filter((row) => ticket != null && row.ticket === ticket);
    const inv = (project.invoices ?? []).filter((row) => invoice != null && row.number.toLowerCase() === invoice.toLowerCase());
    if (tx.length || inv.length) {
      const title = (key: string) => project.documents.find((document) => document.key === key)?.title ?? key;
      return { fixtureProject: project.name, transactionRows: tx.map((row) => ({ ...row, document: title(row.document) })),
        invoiceRows: inv.map((row) => ({ ...row, document: title(row.document) })),
        governingContractCandidates: project.contractCandidates.map(title) };
    }
  }
  return null;
}

async function main() {
  const corpus = arg('--corpus')!;
  const wanted = JSON.parse(readFileSync(arg('--cases')!, 'utf8')) as Array<{ caseRef: string; caseId: string }>;
  const env = new Map(readFileSync(arg('--env-file')!, 'utf8').split(/\r?\n/)
    .map((line) => /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/u.exec(line)).filter(Boolean)
    .map((m) => [m![1]!, m![2]!.replace(/^['"]|['"]$/gu, '')]));
  if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('refusing to run with provider or database keys in the environment');
  }
  const admin = readOnlyClient(createClient(env.get('NEXT_PUBLIC_SUPABASE_URL') ?? env.get('SUPABASE_URL')!,
    env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } })) as unknown as {
      from: (table: string) => { select: (columns: string) => Record<string, (...args: unknown[]) => unknown> } };

  const manifest = JSON.parse(readFileSync(path.join(corpus, 'corpus-manifest.json'), 'utf8')) as { entries: Array<Record<string, unknown>> };
  const byId = new Map(manifest.entries.map((entry) => [String(entry.caseId), entry]));
  const caseFiles = new Map<string, Record<string, unknown>>();
  for (const entry of manifest.entries) {
    const file = path.join(corpus, 'cases', `${sha256(String(entry.caseId)).slice(0, 16)}.json`);
    caseFiles.set(String(entry.caseId), JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>);
  }

  const lines: string[] = [];
  const index: unknown[] = [];
  for (const { caseRef, caseId } of wanted) {
    const entry = byId.get(caseId);
    const file = caseFiles.get(caseId);
    if (!entry || !file) throw new Error(`${caseRef}: not in corpus`);
    if (entry.excluded) continue;
    const resolutionCase = file.resolutionCase as Record<string, unknown>;
    const ruleId = String(entry.ruleId);
    const terms = termsFor(ruleId);
    const evidencePages = new Map<string, number | null>();
    for (const ref of resolutionCase.evidence as Array<{ documentId: string | null; physicalPageNumber: number | null }>) {
      if (ref.documentId) evidencePages.set(ref.documentId, ref.physicalPageNumber ?? evidencePages.get(ref.documentId) ?? null);
    }
    const sources: unknown[] = [];
    const indexSources: unknown[] = [];
    if (entry.source === 'conflict_fixture') {
      sources.push({ kind: 'fixture_source_rows', ...fixtureRows(resolutionCase) });
      indexSources.push({ kind: 'fixture_source_rows' });
    } else {
      for (const documentId of (entry.citedDocumentIds as string[]).slice(0, 3)) {
        const document = await (admin.from('documents').select('id, title, name, document_type').eq('id', documentId) as
          unknown as { maybeSingle: () => Promise<{ data: { title?: string; name?: string; document_type?: string } | null }> }).maybeSingle();
        const rows = await (admin.from('document_extractions').select('id, created_at, data').eq('document_id', documentId) as
          unknown as { is: (c: string, v: null) => { order: (c: string, o: object) => Promise<{ data: unknown[] | null }> } })
          .is('field_key', null).order('created_at', { ascending: false });
        const preferred = pickPreferredExtractionBlob((rows.data ?? []) as Array<{ data?: Record<string, unknown> | null }>);
        const data = (preferred?.data ?? null) as Record<string, unknown> | null;
        const pages = pageTexts(data);
        const citedPage = evidencePages.get(documentId) ?? null;
        const found = windows(pages, terms, citedPage);
        // A transaction workbook's content lives in its persisted rows, not a
        // PDF layer: the cited rows (the evidence names them) are the excerpt.
        const citedRows = [...new Set((resolutionCase.evidence as Array<{ documentId: string | null; label: string | null }>)
          .filter((ref) => ref.documentId === documentId)
          .map((ref) => Number(/\brow (\d+)\b/u.exec(ref.label ?? '')?.[1]))
          .filter((row) => Number.isSafeInteger(row)))].sort((a, b) => a - b).slice(0, 10);
        const workbookRows = citedRows.length === 0 ? [] : ((await (admin.from('transaction_data_rows')
          .select('source_sheet_name, source_row_number, transaction_number, invoice_number, rate_code, rate_description, '
            + 'transaction_quantity, transaction_rate, extended_cost, material, service_item, billing_rate_key, invoice_rate_key')
          .eq('document_id', documentId) as unknown as { in: (c: string, v: number[]) => Promise<{ data: unknown[] | null }> })
          .in('source_row_number', citedRows)).data ?? []);
        sources.push({
          kind: 'cited_document', document: { title: document.data?.title ?? document.data?.name ?? null,
            documentType: document.data?.document_type ?? null }, citedPage, coverage: coverage(data, pages),
          ruleTerms: terms.source, termHits: found.termHits, excerpts: found.excerpts,
          ...(citedRows.length > 0 ? { citedWorkbookRows: citedRows, workbookRows } : {}),
        });
        indexSources.push({ kind: 'cited_document', documentId, citedPage, termHits: found.termHits,
          excerptPages: found.excerpts.map((excerpt) => excerpt.page),
          excerptSha256: found.excerpts.map((excerpt) => sha256(excerpt.excerpt)),
          citedWorkbookRows: citedRows, workbookRowsSha256: sha256(JSON.stringify(workbookRows)) });
      }
    }
    const packet = { caseRef, class: entry.qualificationClass, ruleId, sources };
    lines.push(JSON.stringify(packet));
    index.push({ caseRef, caseId, transmittedDigest: entry.transmittedDigest, packetSha256: sha256(JSON.stringify(packet)),
      sources: indexSources });
  }
  writeFileSync(arg('--out')!, `${lines.join('\n')}\n`);
  writeFileSync(arg('--index')!, `${JSON.stringify(index, null, 1)}\n`);
  console.log(JSON.stringify({ packets: lines.length }));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
