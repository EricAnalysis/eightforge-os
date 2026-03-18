'use client';

import type { ActionJson } from '@/lib/types/rules';

const inputCls =
  'block w-full rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-3 py-2 text-[11px] text-[#F5F7FA] placeholder:text-[#3a3f5a] outline-none focus:border-[#8B5CFF]';
const labelCls = 'mb-1 block text-[11px] font-medium text-[#F5F7FA]';

const TASK_TYPES = [
  'general_review',
  'compliance_review',
  'approval',
  'escalation',
  'follow_up',
];

export function ActionBuilder({
  value,
  onChange,
}: {
  value: ActionJson;
  onChange: (v: ActionJson) => void;
}) {
  const {
    create_task = false,
    task_type = 'general_review',
    title_template = '',
    description_template = '',
    due_in_hours,
    assign_to_role = '',
  } = value;

  const update = (patch: Partial<ActionJson>) => {
    onChange({ ...value, ...patch });
  };

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-[11px] text-[#F5F7FA]">
        <input
          type="checkbox"
          checked={create_task}
          onChange={(e) => update({ create_task: e.target.checked })}
          className="rounded border-[#1A1A3E] bg-[#0A0A20] text-[#8B5CFF] focus:ring-[#8B5CFF]"
          aria-label="Create workflow task when rule matches"
        />
        Create workflow task when rule matches
      </label>

      {create_task && (
        <>
          <div>
            <label className={labelCls}>Task type</label>
            <select
              value={task_type}
              onChange={(e) => update({ task_type: e.target.value })}
              className={inputCls}
            >
              {TASK_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={labelCls}>Title template (optional)</label>
            <input
              type="text"
              value={title_template}
              onChange={(e) => update({ title_template: e.target.value })}
              placeholder="e.g. Review: {{rule_name}}"
              className={inputCls}
            />
          </div>

          <div>
            <label className={labelCls}>Description template (optional)</label>
            <textarea
              value={description_template}
              onChange={(e) => update({ description_template: e.target.value })}
              placeholder="e.g. Auto-generated from rule decision."
              rows={2}
              className={inputCls}
            />
          </div>

          <div>
            <label className={labelCls}>Due in hours (optional)</label>
            <input
              type="number"
              min={0}
              step={1}
              value={due_in_hours ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                update({ due_in_hours: v === '' ? undefined : Math.max(0, Number(v)) });
              }}
              placeholder="e.g. 24"
              className={inputCls}
            />
          </div>

          <div>
            <label className={labelCls}>Assign to role (optional)</label>
            <input
              type="text"
              value={assign_to_role}
              onChange={(e) => update({ assign_to_role: e.target.value || undefined })}
              placeholder="e.g. reviewer"
              className={inputCls}
            />
          </div>
        </>
      )}
    </div>
  );
}
