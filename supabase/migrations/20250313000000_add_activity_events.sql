-- ============================================================================
-- MIGRATION STATUS: ALREADY APPLIED (schema differs from this file)
-- ============================================================================
-- The activity_events table already exists in production with a DIFFERENT
-- schema than what was originally drafted here. DO NOT re-run this migration.
--
-- Production schema uses: changed_by (uuid), old_value (jsonb), new_value (jsonb)
-- This file originally had: actor_user_id (uuid), payload (jsonb)
--
-- Production also has CHECK constraints:
--   entity_type IN ('decision', 'workflow_task')
--   event_type  IN ('created', 'status_changed', 'assignment_changed', 'due_date_changed')
--
-- RLS is enabled with a SELECT policy (activity_events_select_org) for
-- authenticated users scoped to their organization. No INSERT/UPDATE/DELETE
-- policies exist — writes happen via the service role client only.
--
-- This file is kept for history. The canonical schema is in production.
-- ============================================================================

-- (original migration preserved below for reference — NOT safe to run)

/*
create table if not exists public.activity_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  event_type text not null,
  old_value jsonb,
  new_value jsonb,
  changed_by uuid,
  created_at timestamptz not null default now()
);

alter table public.activity_events
  add constraint activity_events_entity_type_check
  check (entity_type = any (array['decision', 'workflow_task']));

alter table public.activity_events
  add constraint activity_events_event_type_check
  check (event_type = any (array['created', 'status_changed', 'assignment_changed', 'due_date_changed']));

create index if not exists idx_activity_events_org_entity
  on public.activity_events (organization_id, entity_type, entity_id, created_at desc);

create index if not exists idx_activity_events_org_created
  on public.activity_events (organization_id, created_at desc);

alter table public.activity_events enable row level security;

create policy activity_events_select_org
  on public.activity_events for select to authenticated
  using (
    exists (
      select 1 from public.user_profiles up
      where up.id = auth.uid() and up.organization_id = activity_events.organization_id
    )
  );
*/
