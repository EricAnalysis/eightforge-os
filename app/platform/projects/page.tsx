export default function ProjectsPage() {
  return (
    <div className="space-y-4">
      <section className="flex items-start justify-between gap-4">
        <div>
          <h2 className="mb-1 text-sm font-semibold text-[#F1F3F5]">Projects</h2>
          <p className="text-xs text-[#8B94A3]">
            Track and manage active projects across your organization. Monitor
            progress, milestones, and team assignments from a single view.
          </p>
        </div>
        <div className="shrink-0">
          <button
            type="button"
            className="rounded-md bg-[#7C5CFF] px-3 py-2 text-[11px] font-medium text-white hover:bg-[#6A4DE0]"
          >
            New Project
          </button>
        </div>
      </section>

      <div className="rounded-lg border border-[#1A1F27] bg-[#0F1115] p-4">
        <div className="text-[11px] font-medium text-[#F1F3F5]">No projects yet</div>
        <div className="mt-1 text-[11px] text-[#8B94A3]">
          Projects will appear here once they are created.
        </div>
      </div>
    </div>
  );
}
