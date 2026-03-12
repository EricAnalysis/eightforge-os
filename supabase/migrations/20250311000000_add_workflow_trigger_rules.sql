-- Workflow trigger rules: map decisions to workflow task creation (organization-scoped).
-- Nullable decision_type, severity, decision_status mean "match any"; conditions jsonb reserved for future use.

create table if not exists public.workflow_trigger_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  is_active boolean not null default true,
  decision_type text,
  severity text,
  decision_status text,
  task_type text not null,
  title_template text not null,
  description_template text not null,
  priority text not null,
  conditions jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_workflow_trigger_rules_org_active
  on public.workflow_trigger_rules (organization_id, is_active)
  where is_active = true;

comment on table public.workflow_trigger_rules is 'Rules that trigger workflow task creation from decisions; null filters match any value.';
