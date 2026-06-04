'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import {
  buildSafeAskContract,
  type AskAvailabilityStatus,
  type AskAnswerContract,
  type AskScope,
} from '@/lib/ask/globalCommand';
import type { AskResponse } from '@/lib/ask/types';

function projectIdFromPathname(pathname: string): string | null {
  const match = pathname.match(/^\/platform\/(?:workspace\/)?projects\/([^/?#]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function availabilityFromDataFound(dataFound: boolean): AskAvailabilityStatus {
  return dataFound ? 'available' : 'unavailable';
}

function mapProjectAskResponse(question: string, response: AskResponse): AskAnswerContract {
  const evidence = response.sources.map((source) => ({
    label: source.label,
    href: source.documentId
      ? `/platform/documents/${encodeURIComponent(source.documentId)}`
      : `/platform/projects/${encodeURIComponent(response.projectId)}`,
    source: [
      source.type,
      source.documentName,
      typeof source.page === 'number' ? `p.${source.page}` : null,
    ].filter(Boolean).join(' / '),
  }));
  const dataFound = evidence.length > 0 || response.confidence !== 'low';

  return {
    scope: 'project',
    question,
    answer: response.answer,
    evidence,
    validationState: response.intent,
    gateImpact: response.reasoning,
    sources: response.sources.map((source) => source.label),
    checkedSources: [
      `existing Ask Project backend`,
      `retrieval: ${response.retrievalUsed}`,
    ],
    nextActions: (response.suggestedActions ?? []).map((action) => ({
      label: action.label,
      href: action.target,
    })),
    availability: availabilityFromDataFound(dataFound),
    dataFound,
    generatedBy: 'existing_project_ask',
  };
}

async function postAskRoute(path: string, token: string, body: Record<string, unknown>): Promise<AskAnswerContract> {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((payload as { error?: string }).error ?? 'Ask request failed.');
  }
  return payload as AskAnswerContract;
}

export function useAskDispatch(pathname: string) {
  const [contract, setContract] = useState<AskAnswerContract | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(question: string, forcedScope?: AskScope) {
    const trimmed = question.trim();
    if (!trimmed) return;
    const routed = buildSafeAskContract({ pathname, question: trimmed, forcedScope });
    setLoading(true);
    setError(null);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;

      if (!token) {
        throw new Error('Authentication required.');
      }

      if (routed.scope === 'project') {
        const projectId = projectIdFromPathname(pathname);
        if (!projectId) {
          setContract({
            ...routed,
            answer: 'This question routed to Project scope, but no project id is available in the current route.',
            checkedSources: ['route project context'],
            dataFound: false,
            availability: 'unavailable',
          });
          return;
        }

        const response = await fetch('/api/ask/project', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ projectId, question: trimmed }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error((payload as { error?: string }).error ?? 'Project Ask request failed.');
        }
        setContract(mapProjectAskResponse(trimmed, payload as AskResponse));
        return;
      }

      const pathByScope: Record<Exclude<AskScope, 'project'>, string> = {
        portfolio: '/api/ask/portfolio',
        intelligence: '/api/ask/intelligence',
        search: '/api/ask/search',
      };
      setContract(await postAskRoute(pathByScope[routed.scope], token, { query: trimmed }));
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : 'Ask request failed.';
      setError(message);
      setContract({
        ...routed,
        answer: message,
        checkedSources: routed.checkedSources.length > 0 ? routed.checkedSources : ['ask route'],
        dataFound: false,
        availability: 'unavailable',
      });
    } finally {
      setLoading(false);
    }
  }

  function dismiss() {
    setContract(null);
    setError(null);
  }

  return {
    contract,
    submit,
    dismiss,
    loading,
    error,
  };
}
