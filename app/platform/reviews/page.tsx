export default function ReviewsPage() {
  return (
    <div className="space-y-4">
      <section>
        <h2 className="mb-2 text-sm font-semibold text-[#F1F3F5]">Reviews</h2>
        <p className="text-xs text-[#8B94A3]">
          Queue and manage human-in-the-loop reviews. Surface items flagged for
          approval, audit, or quality-control sign-off before they proceed.
        </p>
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
