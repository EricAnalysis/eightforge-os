import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config({ path: '.env.local' });
config({ path: '.env.test.local', override: false });

const DEV_PROJECT_REF = 'jpzeckefppmiujwajgvk';
const DEV_ORGANIZATION_ID = '11111111-1111-1111-1111-111111111111';
const GOLDEN_PROJECT_ID = '437502f2-d46d-447f-81e3-f26fa7ba0c14';
const TEST_EMAIL = process.env.E2E_TEST_USER_EMAIL ?? 'e2e-verifier@eightforge.test';
const TEST_PASSWORD = process.env.E2E_TEST_USER_PASSWORD;
const force = process.argv.includes('--force');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function projectRef(url) {
  try {
    return new URL(url).hostname.split('.')[0] ?? null;
  } catch {
    return null;
  }
}

async function findUserByEmail(admin, email) {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;

    const user = data.users.find((candidate) => candidate.email?.toLowerCase() === email.toLowerCase());
    if (user) return user;
    if (data.users.length < 1000) return null;
  }

  throw new Error(`Could not locate ${email} after scanning the Auth user list.`);
}

async function main() {
  const supabaseUrl = required('NEXT_PUBLIC_SUPABASE_URL');
  const serviceRoleKey = required('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = required('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  if (!TEST_PASSWORD) throw new Error('E2E_TEST_USER_PASSWORD is required and is never stored by this script.');

  const resolvedProjectRef = projectRef(supabaseUrl);
  if (resolvedProjectRef !== DEV_PROJECT_REF && !force) {
    throw new Error(
      `Refusing to seed ${resolvedProjectRef ?? 'an invalid Supabase URL'}. Expected dev project ${DEV_PROJECT_REF}. Re-run with --force only after explicitly verifying the target.`,
    );
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let user = await findUserByEmail(admin, TEST_EMAIL);
  if (!user) {
    const { data, error } = await admin.auth.admin.createUser({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
    });
    if (error || !data.user) throw error ?? new Error('Supabase did not return the created test user.');
    user = data.user;
  } else {
    const { data, error } = await admin.auth.admin.updateUserById(user.id, {
      password: TEST_PASSWORD,
      email_confirm: true,
    });
    if (error || !data.user) throw error ?? new Error('Supabase did not return the updated test user.');
    user = data.user;
  }

  // The live authorization model is auth.users -> public.user_profiles.organization_id.
  // "viewer" deliberately keeps this browser identity outside project-admin controls.
  const { error: profileError } = await admin
    .from('user_profiles')
    .upsert({
      id: user.id,
      organization_id: DEV_ORGANIZATION_ID,
      display_name: 'E2E Verifier',
      role: 'viewer',
    }, { onConflict: 'id' });
  if (profileError) throw profileError;

  // Verify the same anon-key/session path used by a browser can read Golden under RLS.
  const browserClient = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: signIn, error: signInError } = await browserClient.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });
  if (signInError || !signIn.user || signIn.user.id !== user.id) {
    throw signInError ?? new Error('The seeded user could not sign in through the browser-equivalent client.');
  }

  const { data: goldenProject, error: goldenProjectError } = await browserClient
    .from('projects')
    .select('id, name')
    .eq('id', GOLDEN_PROJECT_ID)
    .maybeSingle();
  await browserClient.auth.signOut();

  if (goldenProjectError || !goldenProject) {
    throw goldenProjectError ?? new Error('The seeded browser identity cannot read Golden Project through RLS.');
  }

  console.info(`Seeded ${TEST_EMAIL} in dev project ${resolvedProjectRef}; browser-equivalent RLS read succeeded for ${goldenProject.name}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
