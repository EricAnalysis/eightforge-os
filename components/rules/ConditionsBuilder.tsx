'use client';

import type { ConditionJson, Condition, ConditionOperator } from '@/lib/types/rules';

const OPERATORS: ConditionOperator[] = [
  'equals',
  'not_equals',
  'greater_than',
  'greater_than_or_equal',
  'less_than',
  'less_than_or_equal',
  'contains',
  'not_contains',
  'in',
  'not_in',
  'exists',
  'not_exists',
];

const VALUE_LESS_OPS: ConditionOperator[] = ['exists', 'not_exists'];

function needsValue(op: ConditionOperator): boolean {
  return !VALUE_LESS_OPS.includes(op);
}

function parseValueForOperator(op: ConditionOperator, raw: string): unknown {
  if (!needsValue(op)) return null;
  if (op === 'in' || op === 'not_in') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [raw];
    } catch {
      return raw.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  const t = raw.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isNaN(n)) return n;
  return t;
}

function formatValueForInput(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

const inputCls =
  'block w-full rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-3 py-2 text-[11px] text-[#F5F7FA] placeholder:text-[#3a3f5a] outline-none focus:border-[#8B5CFF]';
const labelCls = 'mb-1 block text-[11px] font-medium text-[#F5F7FA]';

export function ConditionsBuilder({
  value,
  onChange,
}: {
  value: ConditionJson;
  onChange: (v: ConditionJson) => void;
}) {
  const { match_type, conditions } = value;

  const setMatchType = (v: 'all' | 'any') => {
    onChange({ ...value, match_type: v });
  };

  const setCondition = (index: number, c: Condition) => {
    const next = [...conditions];
    next[index] = c;
    onChange({ ...value, conditions: next });
  };

  const addCondition = () => {
    onChange({
      ...value,
      conditions: [...conditions, { field_key: '', operator: 'equals', value: null }],
    });
  };

  const removeCondition = (index: number) => {
    const next = conditions.filter((_, i) => i !== index);
    onChange({ ...value, conditions: next });
  };

  return (
    <div className="space-y-4">
      <div>
        <span className={labelCls}>Match</span>
        <div className="flex gap-3">
          <label className="flex items-center gap-2 text-[11px] text-[#F5F7FA]">
            <input
              type="radio"
              name="match_type"
              checked={match_type === 'all'}
              onChange={() => setMatchType('all')}
              className="rounded border-[#1A1A3E] bg-[#0A0A20] text-[#8B5CFF] focus:ring-[#8B5CFF]"
            />
            All conditions (AND)
          </label>
          <label className="flex items-center gap-2 text-[11px] text-[#F5F7FA]">
            <input
              type="radio"
              name="match_type"
              checked={match_type === 'any'}
              onChange={() => setMatchType('any')}
              className="rounded border-[#1A1A3E] bg-[#0A0A20] text-[#8B5CFF] focus:ring-[#8B5CFF]"
            />
            Any condition (OR)
          </label>
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className={labelCls}>Conditions</span>
          <button
            type="button"
            onClick={addCondition}
            className="text-[11px] font-medium text-[#8B5CFF] hover:underline"
          >
            + Add condition
          </button>
        </div>

        <div className="space-y-3">
          {conditions.map((c, i) => (
            <div
              key={i}
              className="flex flex-wrap items-end gap-2 rounded-md border border-[#1A1A3E] bg-[#0A0A20] p-3"
            >
              <div className="min-w-[120px] flex-1">
                <label className={labelCls}>Field key</label>
                <input
                  type="text"
                  value={c.field_key}
                  onChange={(e) => setCondition(i, { ...c, field_key: e.target.value })}
                  placeholder="e.g. amount"
                  className={inputCls}
                />
              </div>
              <div className="w-40 shrink-0">
                <label className={labelCls} htmlFor={`cond-operator-${i}`}>Operator</label>
                <select
                  id={`cond-operator-${i}`}
                  value={c.operator}
                  onChange={(e) =>
                    setCondition(i, {
                      ...c,
                      operator: e.target.value as ConditionOperator,
                      value: VALUE_LESS_OPS.includes(e.target.value as ConditionOperator)
                        ? null
                        : c.value,
                    })
                  }
                  className={inputCls}
                >
                  {OPERATORS.map((op) => (
                    <option key={op} value={op}>
                      {op.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
              </div>
              {needsValue(c.operator) && (
                <div className="min-w-[140px] flex-1">
                  <label className={labelCls}>
                    Value {(c.operator === 'in' || c.operator === 'not_in') && '(JSON array or comma-separated)'}
                  </label>
                  <input
                    type="text"
                    value={formatValueForInput(c.value)}
                    onChange={(e) =>
                      setCondition(i, {
                        ...c,
                        value: parseValueForOperator(c.operator, e.target.value),
                      })
                    }
                    placeholder={
                      c.operator === 'in' || c.operator === 'not_in'
                        ? '["a","b"] or a, b'
                        : 'value'
                    }
                    className={inputCls}
                  />
                </div>
              )}
              <button
                type="button"
                onClick={() => removeCondition(i)}
                className="rounded-md px-2 py-1.5 text-[11px] text-red-400 hover:bg-red-500/10"
                aria-label="Remove condition"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
