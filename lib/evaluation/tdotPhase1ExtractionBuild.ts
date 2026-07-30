import { readFile } from 'node:fs/promises';
import path from 'node:path';

import ts from 'typescript';

import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';

export const TDOT_PHASE1_EXTRACTION_SOURCE_FILES = Object.freeze([
  'lib/evaluation/tdotPhase1ExtractionBuild.ts',
  'lib/extraction/domain/genericContentScheduling.ts',
  'lib/extraction/domain/genericTableArtifacts.ts',
  'lib/extraction/domain/hash.ts',
  'lib/extraction/domain/legacyLocatedObservationAdapter.ts',
  'lib/extraction/domain/opaqueIds.ts',
  'lib/extraction/domain/parserManifest.ts',
  'lib/extraction/domain/regionArbitration.ts',
  'lib/extraction/domain/verifiedField.ts',
  'lib/extraction/ocrObservationSidecar.ts',
  'lib/extraction/pdf/extractText.ts',
  'lib/extraction/pdf/ocrGeometryLayout.ts',
  'lib/extraction/textSanitization.ts',
  'lib/interpretation/semanticColumnMapping.ts',
  'lib/interpretation/step3ShadowBridge.ts',
  'lib/server/documentExtraction.ts',
] as const);

const HARNESS_EXTRACTION_DECLARATIONS = Object.freeze([
  'comparedFields',
  'dependencyClosure',
  'flattenLocatedObservations',
  'locatedPages',
  'manifestInvariantSemanticProjection',
  'runGenericShadowFromBytes',
  'runGenericShadowFromPdf',
  'semanticFragmentKey',
  'toArrayBuffer',
] as const);

export interface ExtractionSourceEntry {
  readonly path: string;
  readonly content: string;
}

function normalizeSource(content: string): string {
  return content.replace(/\r\n?/g, '\n');
}

function validateRelativeSourcePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  if (
    path.isAbsolute(relativePath)
    || normalized.startsWith('../')
    || normalized.includes('/../')
    || normalized === '..'
  ) {
    throw new Error(`Extraction build source must remain repository-relative: ${relativePath}`);
  }
  return normalized;
}

export function deriveImplementationBuildFromEntries(input: {
  readonly sources: readonly ExtractionSourceEntry[];
  readonly harnessDeclarations: readonly ExtractionSourceEntry[];
  readonly runtimeComponents: Readonly<Record<string, string>>;
}): string {
  const allEntries = [...input.sources, ...input.harnessDeclarations].map((entry) => ({
    path: validateRelativeSourcePath(entry.path),
    sha256: sha256Hex(normalizeSource(entry.content)),
  }));
  const paths = allEntries.map(({ path: sourcePath }) => sourcePath);
  if (new Set(paths).size !== paths.length) {
    throw new Error('Extraction build source manifest contains duplicate paths.');
  }
  if (allEntries.length === 0) {
    throw new Error('Extraction build source manifest cannot be empty.');
  }
  const digest = hashCanonical({
    schema: 'phase1-extraction-implementation-source-v1',
    sources: allEntries.sort((left, right) =>
      left.path.localeCompare(right.path)),
    runtime_components: Object.fromEntries(
      Object.entries(input.runtimeComponents)
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  });
  return `source-sha256:${digest}`;
}

function selectedFunctionDeclarations(source: string): ExtractionSourceEntry[] {
  const sourceFile = ts.createSourceFile(
    'lib/evaluation/tdotPhase1Harness.ts',
    normalizeSource(source),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const selected = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement)
      && statement.name
      && HARNESS_EXTRACTION_DECLARATIONS.includes(
        statement.name.text as (typeof HARNESS_EXTRACTION_DECLARATIONS)[number],
      )
    ) {
      selected.set(
        statement.name.text,
        statement.getText(sourceFile),
      );
    }
  }
  const missing = HARNESS_EXTRACTION_DECLARATIONS.filter((name) =>
    !selected.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Extraction build could not resolve harness declarations: ${missing.join(', ')}`,
    );
  }
  return [...selected.entries()].map(([name, content]) => ({
    path: `lib/evaluation/tdotPhase1Harness.ts#${name}`,
    content,
  }));
}

async function packageVersion(
  workspaceRoot: string,
  packageName: string,
): Promise<string> {
  const packageJson = JSON.parse(await readFile(
    path.join(workspaceRoot, 'node_modules', packageName, 'package.json'),
    'utf8',
  )) as { version?: unknown };
  if (typeof packageJson.version !== 'string' || !packageJson.version.trim()) {
    throw new Error(`Extraction runtime package ${packageName} has no version.`);
  }
  return packageJson.version;
}

export async function deriveTdotPhase1ImplementationBuild(
  workspaceRoot = process.cwd(),
): Promise<string> {
  const sources = await Promise.all(
    TDOT_PHASE1_EXTRACTION_SOURCE_FILES.map(async (relativePath) => ({
      path: relativePath,
      content: await readFile(path.join(workspaceRoot, relativePath), 'utf8'),
    })),
  );
  const harnessPath = path.join(
    workspaceRoot,
    'lib/evaluation/tdotPhase1Harness.ts',
  );
  const harnessDeclarations = selectedFunctionDeclarations(
    await readFile(harnessPath, 'utf8'),
  );
  return deriveImplementationBuildFromEntries({
    sources,
    harnessDeclarations,
    runtimeComponents: {
      pdfjs_dist: await packageVersion(workspaceRoot, 'pdfjs-dist'),
      tesseract_js: await packageVersion(workspaceRoot, 'tesseract.js'),
      typescript_ast_parser: ts.version,
    },
  });
}
