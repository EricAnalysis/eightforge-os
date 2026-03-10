export default function IssuesPage() {
  return (
    <div className="space-y-4">
      <section className="flex items-start justify-between gap-4">
        <div>
          <h2 className="mb-1 text-sm font-semibold text-[#F1F3F5]">Issues</h2>
          <p className="text-xs text-[#8B94A3]">
            Track operational issues, exceptions, and anomalies detected across
            your workflows. Triage, assign, and resolve problems from one place.
          </p>
        </div>
        <div className="shrink-0">
          <button
            type="button"
            className="rounded-md bg-[#1A1F27] px-3 py-2 text-[11px] font-medium text-[#F1F3F5] hover:bg-[#252a33]"
          >
            Open Issue
          </button>
        </div>
      </section>

      <div className="rounded-lg border border-[#1A1F27] bg-[#0F1115] p-4">
        <div className="text-[11px] font-medium text-[#F1F3F5]">No issues detected</div>
        <div className="mt-1 text-[11px] text-[#8B94A3]">
          Operational issues and exceptions will surface here automatically.
        </div>
      </div>
    </div>
  );
}
