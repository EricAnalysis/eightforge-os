const WRITE_CONFIRMATION_PREFIX = 'BACKFILL_SOURCE_IDENTITY';

export type SourceIdentityBackfillCliOptions = Readonly<{
  target: string;
  organizationId: string;
  projectId: string | null;
  afterDocumentId: string | null;
  pageSize: number;
  maxDocuments: number;
  write: boolean;
  confirmation: string | null;
}>;

export type SourceIdentityBackfillEnvironment = Readonly<{
  actualHost: string;
  identity: string;
}>;

function parsePositiveInteger(value: string, optionName: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`--${optionName} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`--${optionName} must be a positive integer.`);
  }
  return parsed;
}

export function parseSourceIdentityBackfillOptions(
  argv: readonly string[],
): SourceIdentityBackfillCliOptions {
  const allowedValues = new Set([
    'target',
    'organization-id',
    'project-id',
    'after-document-id',
    'page-size',
    'max-documents',
    'confirm',
  ]);
  const allowedFlags = new Set(['write']);
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (const argument of argv) {
    if (!argument.startsWith('--')) throw new Error(`Unknown positional argument: ${argument}`);
    const separator = argument.indexOf('=');
    if (separator === -1) {
      const flag = argument.slice(2);
      if (flag === 'page-size' || flag === 'max-documents') {
        throw new Error(`--${flag} must be a positive integer.`);
      }
      if (!allowedFlags.has(flag)) throw new Error(`Unknown or incomplete option: --${flag}`);
      flags.add(flag);
    } else {
      const option = argument.slice(2, separator);
      if (!allowedValues.has(option)) throw new Error(`Unknown option: --${option}`);
      if (values.has(option)) throw new Error(`Duplicate option: --${option}`);
      values.set(option, argument.slice(separator + 1));
    }
  }

  const organizationId = values.get('organization-id')?.trim() ?? '';
  const target = values.get('target')?.trim() ?? '';
  if (!organizationId || !target) {
    throw new Error(
      'Usage: vite-node scripts/backfill-source-artifact-identity.ts '
      + '--target=<project-ref-or-host> --organization-id=<uuid> [--project-id=<uuid>] '
      + '[--after-document-id=<uuid>] [--page-size=100] [--max-documents=100] '
      + `[--write --confirm=${WRITE_CONFIRMATION_PREFIX}:<project-ref-or-host>]`,
    );
  }

  const pageSizeRaw = values.get('page-size') ?? '100';
  const maxDocumentsRaw = values.get('max-documents') ?? pageSizeRaw;
  return Object.freeze({
    target,
    organizationId,
    projectId: values.get('project-id')?.trim() || null,
    afterDocumentId: values.get('after-document-id')?.trim() || null,
    pageSize: parsePositiveInteger(pageSizeRaw, 'page-size'),
    maxDocuments: parsePositiveInteger(maxDocumentsRaw, 'max-documents'),
    write: flags.has('write'),
    confirmation: values.get('confirm') ?? null,
  });
}

export function resolveSourceIdentityBackfillEnvironment(
  supabaseUrl: string,
  suppliedTarget: string,
): SourceIdentityBackfillEnvironment {
  let url: URL;
  try {
    url = new URL(supabaseUrl);
  } catch {
    throw new Error('Supabase URL is invalid.');
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const host = url.host.toLowerCase();
  const hostedSuffix = '.supabase.co';
  const projectRef = hostname.endsWith(hostedSuffix)
    ? hostname.slice(0, -hostedSuffix.length)
    : null;
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  const acceptedTargets = new Set([hostname, host]);
  if (projectRef) acceptedTargets.add(projectRef);
  if (loopback) acceptedTargets.add('local');

  const normalizedTarget = suppliedTarget.trim().toLowerCase();
  if (!acceptedTargets.has(normalizedTarget)) {
    throw new Error(
      `--target does not match SUPABASE_URL host ${host}; use the exact host`
      + (projectRef ? ` or project ref ${projectRef}` : '')
      + '.',
    );
  }

  return Object.freeze({
    actualHost: host,
    identity: projectRef ?? host,
  });
}

export function validateSourceIdentityBackfillInvocation(
  argv: readonly string[],
  supabaseUrl: string,
): Readonly<{
  options: SourceIdentityBackfillCliOptions;
  environment: SourceIdentityBackfillEnvironment;
}> {
  const options = parseSourceIdentityBackfillOptions(argv);
  const environment = resolveSourceIdentityBackfillEnvironment(supabaseUrl, options.target);
  if (options.write) {
    const requiredConfirmation = `${WRITE_CONFIRMATION_PREFIX}:${environment.identity}`;
    if (options.confirmation !== requiredConfirmation) {
      throw new Error(`Write mode requires --confirm=${requiredConfirmation}.`);
    }
  }
  return Object.freeze({ options, environment });
}
