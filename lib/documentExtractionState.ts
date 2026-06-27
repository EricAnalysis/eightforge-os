export type DocumentExtractionStepKey = 'uploaded' | 'extracted' | 'facts_confirmed' | 'validated';

export type DocumentExtractionStepState = 'done' | 'current' | 'pending' | 'failed';

export type DocumentExtractionStep = {
  key: DocumentExtractionStepKey;
  label: string;
  state: DocumentExtractionStepState;
};

export type DocumentExtractionStateInput = {
  processingStatus?: string | null;
  operationalStatus?: string | null;
  processedAt?: string | null;
};

export type DocumentExtractionState = {
  steps: DocumentExtractionStep[];
  currentStep: DocumentExtractionStepKey;
  statusLabel: string;
  failed: boolean;
};

export type DocumentExtractionStalenessInput = {
  sourceCreatedAt?: string | null;
  sourceUpdatedAt?: string | null;
  extractionTimestamp?: string | null;
  now?: Date;
};

export type DocumentExtractionStaleness = {
  stale: boolean;
  label: string | null;
};

const STEP_ORDER: Array<{ key: DocumentExtractionStepKey; label: string }> = [
  { key: 'uploaded', label: 'Uploaded' },
  { key: 'extracted', label: 'Extracted' },
  { key: 'facts_confirmed', label: 'Facts Confirmed' },
  { key: 'validated', label: 'Validated' },
];

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ');
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function formatAge(timestamp: number, now: Date): string {
  const delta = Math.max(0, now.getTime() - timestamp);
  const days = Math.floor(delta / 86_400_000);
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'} ago`;
  const hours = Math.floor(delta / 3_600_000);
  if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const minutes = Math.floor(delta / 60_000);
  if (minutes >= 1) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  return 'just now';
}

export function resolveDocumentExtractionState(
  input: DocumentExtractionStateInput,
): DocumentExtractionState {
  const processingStatus = normalize(input.processingStatus);
  const operationalStatus = normalize(input.operationalStatus);
  const failed = processingStatus === 'failed' || operationalStatus === 'failed' || operationalStatus === 'blocked';

  let currentStep: DocumentExtractionStepKey = 'uploaded';
  let statusLabel = 'Uploaded';

  if (failed) {
    currentStep = 'uploaded';
    statusLabel = 'Failed';
  } else if (processingStatus === 'processing' || operationalStatus === 'processing') {
    currentStep = 'uploaded';
    statusLabel = 'Processing';
  } else if (
    processingStatus === 'decisioned' ||
    operationalStatus === 'operationally clear' ||
    operationalStatus === 'validated'
  ) {
    currentStep = 'validated';
    statusLabel = 'Validated';
  } else if (operationalStatus === 'reviewed' || operationalStatus === 'facts confirmed') {
    currentStep = 'facts_confirmed';
    statusLabel = 'Facts Confirmed';
  } else if (processingStatus === 'extracted' || operationalStatus === 'extracted' || input.processedAt) {
    currentStep = 'extracted';
    statusLabel = 'Extracted';
  }

  const currentIndex = STEP_ORDER.findIndex((step) => step.key === currentStep);
  const steps: DocumentExtractionStep[] = STEP_ORDER.map((step, index) => ({
    ...step,
    state: (failed && index === 0
      ? 'failed'
      : index < currentIndex
        ? 'done'
        : index === currentIndex
          ? 'current'
          : 'pending') satisfies DocumentExtractionStepState,
  }));

  return {
    steps,
    currentStep,
    statusLabel,
    failed,
  };
}

export function resolveDocumentExtractionStaleness(
  input: DocumentExtractionStalenessInput,
): DocumentExtractionStaleness {
  const extractionTimestamp = parseTimestamp(input.extractionTimestamp);
  const sourceTimestamp = parseTimestamp(input.sourceUpdatedAt) ?? parseTimestamp(input.sourceCreatedAt);

  if (extractionTimestamp == null || sourceTimestamp == null || extractionTimestamp >= sourceTimestamp) {
    return { stale: false, label: null };
  }

  return {
    stale: true,
    label: `Extracted ${formatAge(extractionTimestamp, input.now ?? new Date())}; source document changed since`,
  };
}
