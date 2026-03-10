export default function ReviewsPage() {
  return (
    <div className="space-y-4">
      <section className="flex items-start justify-between gap-4">
        <div>
          <h2 className="mb-1 text-sm font-semibold text-[#F1F3F5]">Reviews</h2>
          <p className="text-xs text-[#8B94A3]">
            Queue and manage human-in-the-loop reviews. Surface items flagged for
            approval, audit, or quality-control sign-off before they proceed.
          </p>
        </div>
        <div className="shrink-0">
          <button
            type="button"
            className="rounded-md bg-[#1A1F27] px-3 py-2 text-[11px] font-medium text-[#F1F3F5] hover:bg-[#252a33]"
          >
            Start Review
          </button>
        </div>
      </section>

      <div className="rounded-lg border border-[#1A1F27] bg-[#0F1115] p-4">
        <div className="text-[11px] font-medium text-[#F1F3F5]">Review queue is empty</div>
        <div className="mt-1 text-[11px] text-[#8B94A3]">
          Items requiring human review will appear here.
        </div>
      </div>
    </div>
  );
}
