// app/(auth)/login/page.tsx
export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0F1115] text-[#F1F3F5]">
      <div className="w-full max-w-sm rounded-lg border border-[#1A1F27] bg-[#0F1115] p-6">
        <h1 className="mb-2 text-sm font-semibold">Sign in to EightForge OS</h1>
        <p className="mb-4 text-xs text-[#8B94A3]">
          The operating system for automated decision systems in complex operations.
        </p>
        {/* Later: add Supabase auth */}
        <button className="mt-2 w-full rounded-md bg-[#7C5CFF] px-3 py-2 text-xs font-medium text-white hover:bg-[#6A4DE0]">
          Continue
        </button>
      </div>
    </div>
  );
}
