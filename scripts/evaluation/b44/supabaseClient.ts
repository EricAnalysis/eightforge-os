export const supabase = { auth: { getSession: async () => ({ data: { session: { access_token: 'fixture-local-only' } } }) } };
