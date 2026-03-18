'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import { useRouter } from 'next/navigation';

interface UserProfile {
  id: string;
  display_name: string;
  email: string;
  role: string;
  created_at: string;
}

interface TeamMember extends UserProfile {
  organization_id: string;
}

export default function SettingsPage() {
  const router = useRouter();
  const { organization, userId, loading: orgLoading } = useCurrentOrg();

  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    if (orgLoading || !userId || !organization?.id) return;

    const fetchData = async () => {
      try {
        setDataLoading(true);
        setError(null);

        const [profileRes, teamRes] = await Promise.all([
          supabase
            .from('user_profiles')
            .select('id, display_name, email, role, created_at')
            .eq('id', userId)
            .single(),
          supabase
            .from('user_profiles')
            .select('id, display_name, email, role, created_at, organization_id')
            .eq('organization_id', organization.id)
            .order('created_at', { ascending: true })
            .limit(50),
        ]);

        if (profileRes.error) throw profileRes.error;
        if (teamRes.error) throw teamRes.error;

        setUserProfile(profileRes.data);
        setTeamMembers(teamRes.data || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load data');
        console.error('Settings data fetch error:', err);
      } finally {
        setDataLoading(false);
      }
    };

    fetchData();
  }, [orgLoading, userId, organization?.id]);

  const handleSignOut = async () => {
    try {
      setSigningOut(true);
      await supabase.auth.signOut();
      router.replace('/login');
    } catch (err) {
      console.error('Sign out error:', err);
      setError('Failed to sign out');
    } finally {
      setSigningOut(false);
    }
  };

  const formatDate = (date: string | undefined) => {
    if (!date) return '—';
    return new Date(date).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const truncateUuid = (uuid: string) => {
    return uuid.slice(0, 8) + '…';
  };

  const getRoleBadgeClasses = (role: string) => {
    switch (role?.toLowerCase()) {
      case 'admin':
        return 'bg-purple-500/20 text-purple-400 border border-purple-500/40';
      case 'owner':
        return 'bg-amber-500/20 text-amber-400 border border-amber-500/40';
      default:
        return 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]';
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <section className="flex items-start justify-between gap-4">
        <div>
          <h2 className="mb-1 text-sm font-semibold text-[#F5F7FA]">
            Settings
          </h2>
          <p className="text-xs text-[#8B94A3]">
            Workspace, users, roles, and integrations for EightForge.
          </p>
        </div>
      </section>

      {error && (
        <section className="rounded-lg border border-red-500/30 bg-red-500/10 p-4">
          <p className="text-[11px] text-red-400">Error: {error}</p>
        </section>
      )}

      {/* Organization Section */}
      <section>
        <h3 className="mb-3 text-[10px] font-bold uppercase tracking-widest text-[#8B94A3]">
          Organization
        </h3>
        <div className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-4 space-y-3">
          {orgLoading ? (
            <p className="text-[11px] text-[#8B94A3]">Loading…</p>
          ) : (
            <>
              <div className="flex justify-between">
                <span className="text-[12px] text-[#8B94A3]">Name</span>
                <span className="text-[11px] text-[#F5F7FA] font-medium">
                  {organization?.name || '—'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[12px] text-[#8B94A3]">ID</span>
                <span className="text-[11px] text-[#F5F7FA] font-medium">
                  {organization?.id ? truncateUuid(organization.id) : '—'}
                </span>
              </div>
              {organization?.slug && (
                <div className="flex justify-between">
                  <span className="text-[12px] text-[#8B94A3]">Slug</span>
                  <span className="text-[11px] text-[#F5F7FA] font-medium">
                    {organization.slug}
                  </span>
                </div>
              )}
              {organization?.created_at && (
                <div className="flex justify-between">
                  <span className="text-[12px] text-[#8B94A3]">Created</span>
                  <span className="text-[11px] text-[#F5F7FA] font-medium">
                    {formatDate(organization.created_at)}
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {/* Your Profile Section */}
      <section>
        <h3 className="mb-3 text-[10px] font-bold uppercase tracking-widest text-[#8B94A3]">
          Your Profile
        </h3>
        <div className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-4 space-y-3">
          {dataLoading ? (
            <p className="text-[11px] text-[#8B94A3]">Loading…</p>
          ) : userProfile ? (
            <>
              <div className="flex justify-between">
                <span className="text-[12px] text-[#8B94A3]">Display Name</span>
                <span className="text-[11px] text-[#F5F7FA] font-medium">
                  {userProfile.display_name || '—'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[12px] text-[#8B94A3]">Email</span>
                <span className="text-[11px] text-[#F5F7FA] font-medium">
                  {userProfile.email || '—'}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-[12px] text-[#8B94A3]">Role</span>
                <span
                  className={`text-[11px] px-2 py-1 rounded-md font-medium ${getRoleBadgeClasses(userProfile.role)}`}
                >
                  {userProfile.role}
                </span>
              </div>
            </>
          ) : (
            <p className="text-[11px] text-red-400">Failed to load profile</p>
          )}
        </div>
      </section>

      {/* Team Members Section */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[10px] font-bold uppercase tracking-widest text-[#8B94A3]">
            Team Members
          </h3>
          <span className="text-[10px] font-semibold text-[#8B94A3] bg-[#0E0E2A] px-2 py-1 rounded">
            {dataLoading ? '—' : teamMembers.length}
          </span>
        </div>
        <div className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] overflow-hidden">
          {dataLoading ? (
            <div className="p-4">
              <p className="text-[11px] text-[#8B94A3]">Loading…</p>
            </div>
          ) : teamMembers.length > 0 ? (
            <div className="divide-y divide-[#1A1A3E]">
              {teamMembers.map((member) => (
                <div key={member.id} className="p-4 space-y-2">
                  <div className="flex justify-between items-start">
                    <div className="flex-1">
                      <p className="text-[11px] font-medium text-[#F5F7FA]">
                        {member.display_name}
                      </p>
                      <p className="text-[10px] text-[#8B94A3]">
                        {member.email}
                      </p>
                    </div>
                    <span
                      className={`text-[10px] px-2 py-1 rounded-md font-medium whitespace-nowrap ${getRoleBadgeClasses(member.role)}`}
                    >
                      {member.role}
                    </span>
                  </div>
                  <p className="text-[10px] text-[#8B94A3]">
                    Joined {formatDate(member.created_at)}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-4">
              <p className="text-[11px] text-[#8B94A3]">No team members</p>
            </div>
          )}
        </div>
      </section>

      {/* Danger Zone */}
      <section>
        <h3 className="mb-3 text-[10px] font-bold uppercase tracking-widest text-red-500/70">
          Danger Zone
        </h3>
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4">
          <button
            onClick={handleSignOut}
            disabled={signingOut}
            className="w-full rounded-md border border-red-500/40 bg-red-500/10 px-4 py-2 text-[11px] font-medium text-red-400 hover:bg-red-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {signingOut ? 'Signing out…' : 'Sign Out'}
          </button>
        </div>
      </section>
    </div>
  );
}
