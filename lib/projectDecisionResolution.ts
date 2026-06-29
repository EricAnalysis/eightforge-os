export type ProjectDecisionResolutionAction =
  | 'mark_correct'
  | 'request_correction'
  | 'mark_resolved'
  | 'suppress';

type ResolutionRequest = {
  kind: 'feedback' | 'status';
  path: string;
  init: RequestInit;
  optimisticStatus: 'in_review' | 'resolved' | 'dismissed' | null;
  successMessage: string;
};

type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

function buildResolutionRequest(
  decisionId: string,
  action: ProjectDecisionResolutionAction,
  accessToken: string,
): ResolutionRequest {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
  };

  switch (action) {
    case 'mark_correct':
      return {
        kind: 'feedback',
        path: `/api/decisions/${decisionId}/feedback`,
        init: {
          method: 'POST',
          headers,
          body: JSON.stringify({
            is_correct: true,
            feedback_type: 'correct',
            disposition: 'accept',
          }),
        },
        optimisticStatus: null,
        successMessage: 'Decision marked correct.',
      };
    case 'request_correction':
      return {
        kind: 'feedback',
        path: `/api/decisions/${decisionId}/feedback`,
        init: {
          method: 'POST',
          headers,
          body: JSON.stringify({
            is_correct: false,
            review_error_type: 'edge_case',
            feedback_type: 'needs_review',
            disposition: 'escalate',
          }),
        },
        optimisticStatus: 'in_review',
        successMessage: 'Correction requested. Decision moved to review when applicable.',
      };
    case 'mark_resolved':
      return {
        kind: 'status',
        path: `/api/decisions/${decisionId}/status`,
        init: {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ status: 'resolved' }),
        },
        optimisticStatus: 'resolved',
        successMessage: 'Decision marked resolved.',
      };
    case 'suppress':
      return {
        kind: 'status',
        path: `/api/decisions/${decisionId}/status`,
        init: {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ status: 'dismissed' }),
        },
        optimisticStatus: 'dismissed',
        successMessage: 'Decision suppressed.',
      };
    default: {
      const exhaustiveCheck: never = action;
      throw new Error(`Unsupported project decision action: ${exhaustiveCheck}`);
    }
  }
}

export async function executeProjectDecisionResolution(params: {
  decisionId: string;
  action: ProjectDecisionResolutionAction;
  accessToken: string;
  fetcher?: FetchLike;
}): Promise<{
  response: Pick<Response, 'ok' | 'status' | 'json'>;
  kind: 'feedback' | 'status';
  optimisticStatus: 'in_review' | 'resolved' | 'dismissed' | null;
  successMessage: string;
}> {
  const { decisionId, action, accessToken, fetcher = fetch } = params;
  const request = buildResolutionRequest(decisionId, action, accessToken);
  const response = await fetcher(request.path, request.init);

  return {
    response,
    kind: request.kind,
    optimisticStatus: request.optimisticStatus,
    successMessage: request.successMessage,
  };
}
