-- Backbone's guarded version of this policy was superseded by an unguarded duplicate on 2026-03-18 and has not been live since; this migration makes fresh-replay deterministically match confirmed production state, queried 2026-06-22.
DROP POLICY IF EXISTS "rules_select_org" ON public."rules";
CREATE POLICY "rules_select_org" ON public."rules" FOR SELECT USING ((organization_id IS NULL) OR (organization_id = (SELECT up.organization_id FROM user_profiles up WHERE up.id = auth.uid())));

-- Backbone's guarded version of this policy was superseded by an unguarded duplicate on 2026-03-18 and has not been live since; this migration makes fresh-replay deterministically match confirmed production state, queried 2026-06-22.
DROP POLICY IF EXISTS "signals_select_org" ON public."signals";
CREATE POLICY "signals_select_org" ON public."signals" FOR SELECT USING ((organization_id = (SELECT up.organization_id FROM user_profiles up WHERE up.id = auth.uid())));

-- The guarded backbone definition is duplicated by an unguarded 2026-06-09 definition; recreate it deterministically from the production definition confirmed on 2026-06-22.
DROP POLICY IF EXISTS "document_fields_select_authenticated" ON public."document_fields";
CREATE POLICY "document_fields_select_authenticated" ON public."document_fields" FOR SELECT TO authenticated USING (true);
