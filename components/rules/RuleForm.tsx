'use client';

import { useState } from 'react';
import { ConditionsBuilder } from '@/components/rules/ConditionsBuilder';
import { ActionBuilder } from '@/components/rules/ActionBuilder';
import { RuleTestPanel } from '@/components/rules/RuleTestPanel';
import type { ConditionJson, ActionJson } from '@/lib/types/rules';

const inputCls =
  'block w-full rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-3 py-2 text-[11px] text-[#F5F7FA] placeholder:text-[#3a3f5a] outline-none focus:border-[#8B5CFF]';
const labelCls = 'mb-1 block text-[11px] font-medium text-[#F5F7FA]';

const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
const STATUSES = ['active', 'inactive'] as const;

export type RuleFormPayload = {
  domain: string;
  document_type: string;
  rule_group: string | null;
  name: string;
  description: string | null;
  decision_type: string;
  severity: string;
  priority: number;
  status: string;
  condition_json: ConditionJson;
  action_json: ActionJson;
  organization_id: string | null;
};

const defaultConditionJson: ConditionJson = {
  match_type: 'all',
  conditions: [],
};

const defaultActionJson: ActionJson = {};

export function RuleForm({
  initial,
  organizationId,
  onSubmit,
  onCancel,
  submitLabel = 'Save',
  loading = false,
}: {
  initial?: Partial<RuleFormPayload>;
  organizationId: string | null;
  onSubmit: (payload: RuleFormPayload) => void;
  onCancel: () => void;
  submitLabel?: string;
  loading?: boolean;
}) {
  const [domain, setDomain] = useState(initial?.domain ?? '');
  const [documentType, setDocumentType] = useState(initial?.document_type ?? '');
  const [ruleGroup, setRuleGroup] = useState(initial?.rule_group ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [decisionType, setDecisionType] = useState(initial?.decision_type ?? '');
  const [severity, setSeverity] = useState(initial?.severity ?? 'medium');
  const [priority, setPriority] = useState(
    initial?.priority ?? 0,
  );
  const [status, setStatus] = useState(initial?.status ?? 'active');
  const [conditionJson, setConditionJson] = useState<ConditionJson>(
    initial?.condition_json ?? defaultConditionJson,
  );
  const [actionJson, setActionJson] = useState<ActionJson>(
    initial?.action_json ?? defaultActionJson,
  );
  const [showTest, setShowTest] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      domain: domain.trim(),
      document_type: documentType.trim(),
      rule_group: ruleGroup.trim() || null,
      name: name.trim(),
      description: description.trim() || null,
      decision_type: decisionType.trim(),
      severity,
      priority: Number(priority) || 0,
      status,
      condition_json: conditionJson,
      action_json: actionJson,
      organization_id: organizationId,
    });
  };

  const valid =
    domain.trim() &&
    documentType.trim() &&
    name.trim() &&
    decisionType.trim() &&
    conditionJson.conditions.length > 0;

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className={labelCls}>Domain <span className="text-red-400">*</span></label>
          <input
            type="text"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="e.g. compliance"
            className={inputCls}
            required
          />
        </div>
        <div>
          <label className={labelCls}>Document type <span className="text-red-400">*</span></label>
          <input
            type="text"
            value={documentType}
            onChange={(e) => setDocumentType(e.target.value)}
            placeholder="e.g. invoice, contract"
            className={inputCls}
            required
          />
        </div>
      </div>

      <div>
        <label className={labelCls}>Rule group</label>
        <input
          type="text"
          value={ruleGroup}
          onChange={(e) => setRuleGroup(e.target.value)}
          placeholder="e.g. high_value"
          className={inputCls}
        />
      </div>

      <div>
        <label className={labelCls}>Name <span className="text-red-400">*</span></label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. High value invoice without PO"
          className={inputCls}
          required
        />
      </div>

      <div>
        <label className={labelCls}>Description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional description"
          rows={2}
          className={inputCls}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className={labelCls}>Decision type <span className="text-red-400">*</span></label>
          <input
            type="text"
            value={decisionType}
            onChange={(e) => setDecisionType(e.target.value)}
            placeholder="e.g. compliance_alert"
            className={inputCls}
            required
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="rule-severity">Severity</label>
          <select
            id="rule-severity"
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
            className={inputCls}
            aria-label="Severity"
          >
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className={labelCls}>Priority (lower = higher priority)</label>
          <input
            type="number"
            min={0}
            value={priority}
            onChange={(e) => setPriority(Number(e.target.value) || 0)}
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="rule-status">Status</label>
          <select
            id="rule-status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className={inputCls}
            aria-label="Status"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="rounded-lg border border-[#1A1A3E] bg-[#0A0A20] p-4">
        <div className="mb-3 text-[11px] font-medium text-[#F5F7FA]">Conditions</div>
        <ConditionsBuilder value={conditionJson} onChange={setConditionJson} />
      </div>

      <div className="rounded-lg border border-[#1A1A3E] bg-[#0A0A20] p-4">
        <div className="mb-3 text-[11px] font-medium text-[#F5F7FA]">Actions</div>
        <ActionBuilder value={actionJson} onChange={setActionJson} />
      </div>

      <div>
        <button
          type="button"
          onClick={() => setShowTest((s) => !s)}
          className="text-[11px] font-medium text-[#8B5CFF] hover:underline"
          aria-label={showTest ? 'Hide rule test panel' : 'Show rule test panel'}
          title={showTest ? 'Hide rule test panel' : 'Show rule test panel'}
        >
          {showTest ? 'Hide' : 'Show'} rule test panel
        </button>
        {showTest && (
          <div className="mt-3">
            <RuleTestPanel
              ruleName={name || 'Untitled rule'}
              conditionJson={conditionJson}
              actionJson={actionJson}
            />
          </div>
        )}
      </div>

      <div className="flex gap-2 border-t border-[#1A1A3E] pt-4">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-[#1A1A3E] px-3 py-2 text-[11px] font-medium text-[#8B94A3] hover:bg-[#1A1A3E]"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!valid || loading}
          className="rounded-md bg-[#8B5CFF] px-3 py-2 text-[11px] font-medium text-white hover:bg-[#7A4FE8] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  );
}
