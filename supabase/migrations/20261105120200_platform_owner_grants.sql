-- Platform owner: one authenticated identity that administers EightForge and
-- Forgewing platform-wide tools (processing hold, workflow assessment review,
-- improvement lifecycle, project intelligence, repository plans).
--
-- It replaces the INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS/ROLES environment
-- allowlists as the authority behind resolveWorkflowPlatformReviewAccess.
-- Organization roles (owner/admin) stay tenant-scoped and grant nothing here.
--
-- Authority is an append-only grant ledger keyed by auth user id:
--   * a user is the platform owner iff their latest event is a grant;
--   * every grant and revocation names who recorded it, why, when, and the
--     database role that recorded it;
--   * no API role (anon, authenticated, service_role) can write the ledger:
--     grants are made only by a direct database session (the owner's SQL
--     editor). Compromising the application cannot create a platform owner;
--   * at most one platform owner is active at a time ("one identity, for
--     now"); change owners by revoking, then granting.
--
-- Bootstrap (owner, once, after this migration is applied):
--   INSERT INTO public.platform_owner_grant_events (subject_user_id, granted, recorded_by, reason)
--   SELECT id, true, id, 'Founder bootstrap: platform owner for EightForge and Forgewing'
--   FROM auth.users WHERE email = '<owner login email>';
-- Until then nobody is platform owner, so the platform tools stay closed, as
-- they are today with the allowlists unset.

SET lock_timeout = '10s';

CREATE TABLE public.platform_owner_grant_events (
  event_seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_user_id uuid NOT NULL,
  granted boolean NOT NULL,
  recorded_by uuid NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  recorded_by_db_role text NOT NULL DEFAULT current_user
);

CREATE INDEX platform_owner_grant_events_subject_idx
  ON public.platform_owner_grant_events (subject_user_id, event_seq DESC);

COMMENT ON TABLE public.platform_owner_grant_events IS
  'Append-only platform-owner grants and revocations. Written only by direct database sessions; read by is_platform_owner().';

-- Append-only.
CREATE FUNCTION public.platform_owner_grant_events_refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'platform_owner_grant_events is append-only'
    USING ERRCODE = '55000', DETAIL = 'platform_owner_grant_immutable';
END;
$$;

CREATE TRIGGER platform_owner_grant_events_immutable
  BEFORE UPDATE OR DELETE ON public.platform_owner_grant_events
  FOR EACH ROW EXECUTE FUNCTION public.platform_owner_grant_events_refuse_mutation();
CREATE TRIGGER platform_owner_grant_events_no_truncate
  BEFORE TRUNCATE ON public.platform_owner_grant_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.platform_owner_grant_events_refuse_mutation();

-- Every event names real accounts, and at most one owner is active.
-- No foreign keys: deleting an account must not be blocked by (or erase) the
-- audit history; existence is checked when the event is recorded.
CREATE FUNCTION public.platform_owner_grant_events_validate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.user_profiles WHERE id = NEW.subject_user_id) THEN
    RAISE EXCEPTION 'platform owner subject has no user profile'
      USING ERRCODE = '23503', DETAIL = 'platform_owner_subject_unknown';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_profiles WHERE id = NEW.recorded_by) THEN
    RAISE EXCEPTION 'platform owner event recorder has no user profile'
      USING ERRCODE = '23503', DETAIL = 'platform_owner_recorder_unknown';
  END IF;
  -- Serialize grants so two concurrent grants cannot both become active.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('eightforge:platform_owner_grants', 0));
  IF NEW.granted AND EXISTS (
    SELECT 1
    FROM (
      SELECT DISTINCT ON (subject_user_id) subject_user_id, granted
      FROM public.platform_owner_grant_events
      ORDER BY subject_user_id, event_seq DESC
    ) latest
    WHERE latest.granted AND latest.subject_user_id <> NEW.subject_user_id
  ) THEN
    RAISE EXCEPTION 'another platform owner is active; revoke it first'
      USING ERRCODE = '55000', DETAIL = 'platform_owner_already_active';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER platform_owner_grant_events_validate
  BEFORE INSERT ON public.platform_owner_grant_events
  FOR EACH ROW EXECUTE FUNCTION public.platform_owner_grant_events_validate();

-- The single source of truth for "is this account the platform owner".
CREATE FUNCTION public.is_platform_owner(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT coalesce((
    SELECT e.granted
    FROM public.platform_owner_grant_events e
    WHERE e.subject_user_id = p_user_id
    ORDER BY e.event_seq DESC
    LIMIT 1
  ), false);
$$;

ALTER TABLE public.platform_owner_grant_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.platform_owner_grant_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.platform_owner_grant_events TO service_role;

REVOKE ALL ON FUNCTION
  public.platform_owner_grant_events_refuse_mutation(),
  public.platform_owner_grant_events_validate(),
  public.is_platform_owner(uuid)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_platform_owner(uuid) TO service_role;

RESET lock_timeout;
