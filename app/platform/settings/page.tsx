export default function SettingsPage() {
  return (
    <div className="space-y-4">
      <section className="flex items-start justify-between gap-4">
        <div>
          <h2 className="mb-1 text-sm font-semibold text-[#F1F3F5]">
            Settings
          </h2>
          <p className="text-xs text-[#8B94A3]">
            Workspace, users, roles, and integrations for EightForge OS.
          </p>
        </div>
        <div className="shrink-0">
          <button
            type="button"
            className="rounded-md bg-[#1A1F27] px-3 py-2 text-[11px] font-medium text-[#F1F3F5] hover:bg-[#252a33]"
          >
            Invite Member
          </button>
        </div>
      </section>

      <section className="rounded-lg border border-[#1A1F27] bg-[#0F1115] p-3">
        <div className="mb-2 text-[11px] font-medium text-[#F1F3F5]">
          Configuration (mock)
        </div>
        <p className="text-[11px] text-[#8B94A3]">
          This is where organization settings and permissions will be managed.
        </p>
      </section>
    </div>
  );
}
