'use client';

import { useState, useMemo } from 'react';
import { evaluateRule } from '@/lib/ruleEvaluation';
import type { Facts, RuleRow, ConditionJson } from '@/lib/types/rules';

const inputCls =
  'rounded-md border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-3 py-2 text-[11px] text-[var(--ef-text-primary)] placeholder:text-[var(--ef-text-faint)] outline-none focus:border-[var(--ef-purple-primary)]';
const labelCls = 'mb-1 block text-[11px] font-medium text-[var(--ef-text-primary)]';

function parseFactValue(raw: string): string | number | boolean | null {
  const t = raw.trim();
  if (t === '') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  const n = Number(t);
  if (!Number.isNaN(n)) return n;
  return t;
}

export function RuleTestPanel({
  ruleName,
  conditionJson,
  actionJson,
}: {
  ruleName: string;
  conditionJson: ConditionJson;
  actionJson: Record<string, unknown>;
}) {
  const [factRows, setFactRows] = useState<Array<{ key: string; value: string }>>([
    { key: '', value: '' },
  ]);
  const [result, setResult] = useState<{
    matched: boolean;
    condition_results: Array<{
      field_key: string;
      operator: string;
      expected: unknown;
      actual: unknown;
      passed: boolean;
    }>;
  } | null>(null);

  const facts: Facts = useMemo(() => {
    const out: Record<string, string | number | boolean | null> = {};
    for (const row of factRows) {
      const k = row.key.trim();
      if (!k) continue;
      out[k] = parseFactValue(row.value);
    }
    return out;
  }, [factRows]);

  const mockRule: RuleRow = useMemo(
    () =>
      ({
        id: 'test',
        organization_id: null,
        domain: '',
        document_type: '',
        rule_group: null,
        name: ruleName,
        description: null,
        decision_type: 'test',
        severity: 'medium',
        priority: 0,
        status: 'active',
        condition_json: conditionJson,
        action_json: actionJson as RuleRow['action_json'],
        created_at: '',
        updated_at: '',
        created_by: null,
        updated_by: null,
      }) as RuleRow,
    [ruleName, conditionJson, actionJson],
  );

  const runTest = () => {
    const evalResult = evaluateRule(mockRule, facts);
    setResult({
      matched: evalResult.matched,
      condition_results: evalResult.condition_results,
    });
  };

  const addRow = () => {
    setFactRows((prev) => [...prev, { key: '', value: '' }]);
  };

  const setRow = (index: number, field: 'key' | 'value', val: string) => {
    setFactRows((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: val };
      return next;
    });
  };

  const removeRow = (index: number) => {
    setFactRows((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-4 rounded-lg border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] p-4">
      <div className="text-[11px] font-medium text-[var(--ef-text-primary)]">Rule test</div>
      <p className="text-[10px] text-[var(--ef-text-muted)]">
        Enter mock facts as key/value pairs and run evaluation to see if the rule matches and which conditions pass or fail.
      </p>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className={labelCls}>Mock facts</span>
          <button
            type="button"
            onClick={addRow}
            className="text-[11px] font-medium text-[var(--ef-purple-primary)] hover:underline"
          >
            + Add fact
          </button>
        </div>
        <div className="space-y-2">
          {factRows.map((row, i) => (
            <div key={i} className="flex gap-2">
              <input
                type="text"
                value={row.key}
                onChange={(e) => setRow(i, 'key', e.target.value)}
                placeholder="field_key"
                className={`flex-1 ${inputCls}`}
              />
              <input
                type="text"
                value={row.value}
                onChange={(e) => setRow(i, 'value', e.target.value)}
                placeholder="value (number, true/false, or text)"
                className={`flex-1 ${inputCls}`}
              />
              <button
                type="button"
                onClick={() => removeRow(i)}
                className="shrink-0 rounded px-2 text-[11px] text-[var(--ef-critical)] hover:bg-[var(--ef-critical-a10)]"
                aria-label="Remove row"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      </div>

      <button
        type="button"
        onClick={runTest}
        className="rounded-md bg-[var(--ef-purple-primary)] px-3 py-2 text-[11px] font-medium text-white hover:bg-[var(--ef-purple-glow)]"
      >
        Run evaluation
      </button>

      {result && (
        <div className="space-y-2 border-t border-[var(--ef-surface-elevated)] pt-3">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium text-[var(--ef-text-primary)]">Result:</span>
            <span
              className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${
                result.matched
                  ? 'bg-[var(--ef-success-a20)] text-[var(--ef-success)] border border-[var(--ef-success-a40)]'
                  : 'bg-[var(--ef-surface-elevated)] text-[var(--ef-text-muted)] border border-[var(--ef-surface-elevated)]'
              }`}
            >
              {result.matched ? 'Matched' : 'No match'}
            </span>
          </div>
          <div className="text-[11px] text-[var(--ef-text-muted)]">Conditions:</div>
          <ul className="space-y-1.5">
            {result.condition_results.map((cr, i) => (
              <li
                key={i}
                className={`rounded px-2 py-1.5 text-[11px] ${
                  cr.passed ? 'bg-[var(--ef-success-bg)] text-[var(--ef-success-soft)]' : 'bg-[var(--ef-critical-a10)] text-[var(--ef-critical-soft)]'
                }`}
              >
                <span className="font-medium">{cr.field_key}</span>{' '}
                <span className="text-[var(--ef-text-muted)]">{cr.operator}</span>{' '}
                {cr.operator !== 'exists' && cr.operator !== 'not_exists' && (
                  <>
                    expected: <code className="rounded bg-black/20 px-1">{JSON.stringify(cr.expected)}</code>
                    {' · '}
                    actual: <code className="rounded bg-black/20 px-1">{JSON.stringify(cr.actual)}</code>
                  </>
                )}
                {' · '}
                {cr.passed ? '✓ passed' : '✗ failed'}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
