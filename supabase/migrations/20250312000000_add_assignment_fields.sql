-- Assignment and ownership fields for decisions and workflow_tasks.
-- Adds display_name to user_profiles so assignees can be shown by name.
-- Safe, additive-only: all new columns are nullable, no existing data affected.

-- 1. Add display_name to user_profiles for assignee display
alter table public.user_profiles
  add column if not exists display_name text;

-- Backfill display_name from auth.users email for existing rows
update public.user_profiles
set display_name = (
  select email from auth.users where auth.users.id = user_profiles.id
)
where display_name is null;

-- 2. Add assignment columns to decisions
alter table public.decisions
  add column if not exists assigned_to uuid,
  add column if not exists assigned_at timestamptz,
  add column if not exists assigned_by uuid;

do $$ begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'decisions_assigned_to_fkey'
  ) then
    alter table public.decisions
      add constraint decisions_assigned_to_fkey
      foreign key (assigned_to) references public.user_profiles(id);
  end if;

  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'decisions_assigned_by_fkey'
  ) then
    alter table public.decisions
      add constraint decisions_assigned_by_fkey
      foreign key (assigned_by) references public.user_profiles(id);
  end if;
end $$;

-- 3. Add assignment tracking to workflow_tasks (assigned_to column already exists)
alter table public.workflow_tasks
  add column if not exists assigned_at timestamptz,
  add column if not exists assigned_by uuid;

do $$ begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'workflow_tasks_assigned_to_fkey'
  ) then
    alter table public.workflow_tasks
      add constraint workflow_tasks_assigned_to_fkey
      foreign key (assigned_to) references public.user_profiles(id);
  end if;

  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'workflow_tasks_assigned_by_fkey'
  ) then
    alter table public.workflow_tasks
      add constraint workflow_tasks_assigned_by_fkey
      foreign key (assigned_by) references public.user_profiles(id);
  end if;
end $$;

-- 4. Partial indexes for assignment queries
create index if not exists idx_decisions_assigned_to
  on public.decisions(assigned_to) where assigned_to is not null;

create index if not exists idx_workflow_tasks_assigned_to
  on public.workflow_tasks(assigned_to) where assigned_to is not null;
