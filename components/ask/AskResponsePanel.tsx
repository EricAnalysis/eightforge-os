import type { AskResponse } from '@/lib/ask/types';
import { AskActionsRow } from '@/components/ask/AskActionsRow';
import { AskAnswerBlock } from '@/components/ask/AskAnswerBlock';
import { AskFollowups } from '@/components/ask/AskFollowups';
import { AskSourcesList } from '@/components/ask/AskSourcesList';
import { adaptAskResponseForPanel } from '@/components/ask/askResponseAdapter';

type AskResponsePanelProps = {
  response: AskResponse;
  projectId: string;
  pending?: boolean;
  onSelectFollowup: (question: string) => void;
};

function sectionHeading(label: string) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7F90AA]">
      {label}
    </p>
  );
}

export function AskResponsePanel({
  response,
  projectId,
  pending = false,
  onSelectFollowup,
}: AskResponsePanelProps) {
  const model = adaptAskResponseForPanel(response, projectId);
  const hasReasoning = Boolean(model.reasoning)
    || model.assumptions.length > 0
    || model.limitations.length > 0;

  return (
    <section className="rounded-xl border border-[#2F3B52]/70 bg-[linear-gradient(180deg,rgba(15,23,42,0.96),rgba(10,15,26,0.96))] px-4 py-4">
      <AskAnswerBlock
        answer={model.answer}
        confidence={model.confidence}
        confidenceChipLabel={model.confidenceChipLabel}
        retrievalChipLabel={model.retrievalChipLabel}
      />

      <div className="mt-3 border-t border-[#2F3B52]/50 pt-3">
        <p className="text-[11px] text-[#94A3B8]">
          {model.contextLine}
          <span className="text-[#64748B]"> / {model.confidenceScore}/100</span>
        </p>
      </div>

      <div className="mt-4 border-t border-[#2F3B52]/50 pt-3">
        {sectionHeading('Sources')}
        <div className="mt-2.5">
          <AskSourcesList sources={model.sources} />
        </div>
      </div>

      {model.actions.length > 0 ? (
        <div className="mt-4 border-t border-[#2F3B52]/50 pt-3">
          {sectionHeading('Actions')}
          <div className="mt-2.5">
            <AskActionsRow actions={model.actions} />
          </div>
        </div>
      ) : null}

      {model.relatedQuestions.length > 0 ? (
        <div className="mt-4 border-t border-[#2F3B52]/50 pt-3">
          {sectionHeading('Follow Up')}
          <div className="mt-2.5">
            <AskFollowups
              questions={model.relatedQuestions}
              disabled={pending}
              onSelect={onSelectFollowup}
            />
          </div>
        </div>
      ) : null}

      {hasReasoning ? (
        <details
          open={model.showReasoningByDefault}
          className="mt-4 border-t border-[#2F3B52]/50 pt-3"
        >
          <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-[0.18em] text-[#94A3B8] transition hover:text-[#E5EDF7]">
            Why this answer
          </summary>

          <div className="mt-3 space-y-3 text-[11px] leading-relaxed text-[#C7D2E3]">
            {model.reasoning ? (
              <div className="space-y-1">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7F90AA]">
                  Reasoning
                </p>
                <p>{model.reasoning}</p>
              </div>
            ) : null}

            {model.assumptions.length > 0 ? (
              <div className="space-y-1">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7F90AA]">
                  Assumptions
                </p>
                <div className="space-y-1">
                  {model.assumptions.map((assumption) => (
                    <p key={assumption}>{assumption}</p>
                  ))}
                </div>
              </div>
            ) : null}

            {model.limitations.length > 0 ? (
              <div className="space-y-1">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7F90AA]">
                  Limitations
                </p>
                <div className="space-y-1">
                  {model.limitations.map((limitation) => (
                    <p key={limitation}>{limitation}</p>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
    </section>
  );
}
