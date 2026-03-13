export default function SignalsPage() {
  return (
    <div className="space-y-4">
      <section className="flex items-start justify-between gap-4">
        <div>
          <h2 className="mb-1 text-sm font-semibold text-[#F5F7FA]">Signals</h2>
          <p className="text-xs text-[#8B94A3]">
            Track operational signals, exceptions, and anomalies detected across
            your workflows. Triage, assign, and resolve problems from one place.
          </p>
        </div>
        <div className="shrink-0">
          <button
            type="button"
            className="rounded-md border border-[#1A1A3E] bg-[#0E0E2A] px-3 py-2 text-[11px] font-medium text-[#F5F7FA] transition-colors hover:bg-[#252548]"
          >
            Report Signal
          </button>
        </div>
      </section>

      <div className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-4">
        <div className="text-[11px] font-medium text-[#F5F7FA]">No signals detected</div>
        <div className="mt-1 text-[11px] text-[#8B94A3]">
          Operational signals and exceptions will surface here automatically.
        </div>
      </div>
    </div>
  );
}
