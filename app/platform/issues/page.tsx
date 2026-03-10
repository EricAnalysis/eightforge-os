export default function IssuesPage() {
  return (
    <div className="space-y-4">
      <section>
        <h2 className="mb-2 text-sm font-semibold text-[#F1F3F5]">Issues</h2>
        <p className="text-xs text-[#8B94A3]">
          Track operational issues, exceptions, and anomalies detected across
          your workflows. Triage, assign, and resolve problems from one place.
        </p>
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
