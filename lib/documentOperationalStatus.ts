export type DocumentOperationalTone =
  | 'danger'
  | 'warning'
  | 'info'
  | 'success'
  | 'muted';

export type DocumentReviewState =
  | 'not_reviewed'
  | 'in_review'
  | 'approved'
  | 'needs_correction'
  | null
  | undefined;

export type DocumentOperationalStatusInput = {
  processingStatus: string | null | undefined;
  reviewStatus?: DocumentReviewState;
  reviewedAt?: string | null;
  processedAt?: string | null;
  unresolvedFindingCount?: number | null;
  pendingActionCount?: number | null;
  blockedCount?: number | null;
  missingSupportCount?: number | null;
  extractionFollowUpRequired?: boolean | null;
};

export type DocumentOperationalStatus = {
  label: string;
  tone: DocumentOperationalTone;
  needsReview: boolean;
  approvedWhileWorkRemains: boolean;
};

function titleize(value: string | null | undefined): string {
  if (!value) return 'Unknown';
  return value
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function count(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function isReviewStale(params: {
  reviewStatus: DocumentReviewState;
  reviewedAt?: string | null;
  processedAt?: string | null;
}): boolean {
  if (params.reviewStatus !== 'approved' || !params.reviewedAt || !params.processedAt) {
    return false;
  }

  const reviewedTime = new Date(params.reviewedAt).getTime();
  const processedTime = new Date(params.processedAt).getTime();
  if (!Number.isFinite(reviewedTime) || !Number.isFinite(processedTime)) {
    return false;
  }

  return processedTime > reviewedTime;
}

export function resolveDocumentOperationalStatus(
  input: DocumentOperationalStatusInput,
): DocumentOperationalStatus {
  const processingStatus = input.processingStatus ?? 'unknown';
  const reviewStatus = input.reviewStatus ?? 'not_reviewed';
  const blockedCount = count(input.blockedCount);
  const unresolvedFindingCount = count(input.unresolvedFindingCount);
  const pendingActionCount = count(input.pendingActionCount);
  const missingSupportCount = count(input.missingSupportCount);
  const unresolvedWorkRemaining =
    unresolvedFindingCount > 0 ||
    pendingActionCount > 0 ||
    missingSupportCount > 0 ||
    blockedCount > 0;
  const openOperatorReview =
    reviewStatus === 'needs_correction' || reviewStatus === 'in_review';
  const staleReviewedExtraction = isReviewStale({
    reviewStatus,
    reviewedAt: input.reviewedAt,
    processedAt: input.processedAt,
  });
  const needsLedgerReview =
    openOperatorReview ||
    staleReviewedExtraction ||
    Boolean(input.extractionFollowUpRequired) ||
    (reviewStatus !== 'approved' && unresolvedWorkRemaining);
  const approvedWhileWorkRemains =
    reviewStatus === 'approved' && unresolvedWorkRemaining && !needsLedgerReview;

  if (processingStatus === 'failed') {
    return {
      label: 'Failed',
      tone: 'danger',
      needsReview: false,
      approvedWhileWorkRemains,
    };
  }

  if (blockedCount > 0) {
    return {
      label: 'Blocked',
      tone: 'danger',
      needsReview: true,
      approvedWhileWorkRemains,
    };
  }

  if (needsLedgerReview) {
    return {
      label: 'Needs review',
      tone: 'warning',
      needsReview: true,
      approvedWhileWorkRemains,
    };
  }

  if (approvedWhileWorkRemains) {
    return {
      label: 'Warning',
      tone: 'info',
      needsReview: false,
      approvedWhileWorkRemains,
    };
  }

  if (reviewStatus === 'approved') {
    return {
      label: 'Reviewed',
      tone: 'success',
      needsReview: false,
      approvedWhileWorkRemains,
    };
  }

  if (processingStatus === 'processing') {
    return {
      label: 'Processing',
      tone: 'info',
      needsReview: false,
      approvedWhileWorkRemains,
    };
  }

  if (processingStatus === 'extracted') {
    return {
      label: 'Extracted',
      tone: 'info',
      needsReview: false,
      approvedWhileWorkRemains,
    };
  }

  if (processingStatus === 'decisioned') {
    return {
      label: 'Operationally clear',
      tone: 'success',
      needsReview: false,
      approvedWhileWorkRemains,
    };
  }

  return {
    label: titleize(processingStatus),
    tone: 'muted',
    needsReview: false,
    approvedWhileWorkRemains,
  };
}
