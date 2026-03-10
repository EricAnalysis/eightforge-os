export default function AgentsPage() {
  return (
    <div className="space-y-4">
      <section>
        <h2 className="mb-2 text-sm font-semibold text-[#F1F3F5]">Agents</h2>
        <p className="text-xs text-[#8B94A3]">
          Configure and monitor autonomous agents operating within your
          workflows. View agent status, activity logs, and performance metrics.
        </p>
      </section>

      <div className="rounded-lg border border-[#1A1F27] bg-[#0F1115] p-4">
        <div className="text-[11px] font-medium text-[#F1F3F5]">No agents configured</div>
        <div className="mt-1 text-[11px] text-[#8B94A3]">
          Agents you deploy will appear here once they are active.
        </div>
      </div>
    </div>
  );
}
