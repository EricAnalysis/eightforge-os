export default function SettingsPage() {
  return (
    <div className="space-y-4">
      <section className="flex items-start justify-between gap-4">
        <div>
          <h2 className="mb-1 text-sm font-semibold text-[#F5F7FA]">
            Settings
          </h2>
          <p className="text-xs text-[#8B94A3]">
            Workspace, users, roles, and integrations for EightForge.
          </p>
        </div>
        <div className="shrink-0">
          <button
            type="button"
            className="rounded-md border border-[#1A1A3E] bg-[#0E0E2A] px-3 py-2 text-[11px] font-medium text-[#F5F7FA] transition-colors hover:bg-[#252548]"
          >
            Invite Member
          </button>
        </div>
      </section>

      <section className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-3">
        <div className="mb-2 text-[11px] font-medium text-[#F5F7FA]">
          Configuration
        </div>
        <p className="text-[11px] text-[#8B94A3]">
          Organization settings, permissions, and integrations will be managed here.
        </p>
      </section>
    </div>
  );
}
