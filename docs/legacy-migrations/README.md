20260407_create_approval_snapshots.sql is archived as non-authoritative: superseded by supabase/migrations/20260602001000_create_approval_snapshots.sql; the only divergent constraint UNIQUE(project_id, created_at) was intentionally NOT carried forward because project_approval_snapshots is append-only audit state.

20250314_verification_checklist.sql is archived as non-authoritative: it contains read-only post-migration verification SELECT queries and was moved out of supabase/migrations so migration tooling only sees executable migration files.
