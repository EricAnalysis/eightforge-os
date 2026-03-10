export default function ProjectsPage() {
  return (
    <div className="space-y-4">
      <section>
        <h2 className="mb-2 text-sm font-semibold text-[#F1F3F5]">Projects</h2>
        <p className="text-xs text-[#8B94A3]">
          Track and manage active projects across your organization. Monitor
          progress, milestones, and team assignments from a single view.
        </p>
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
