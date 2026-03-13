export function EightForgeLogo({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="ef-grad" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#8B5CFF" />
          <stop offset="100%" stopColor="#B794FF" />
        </linearGradient>
      </defs>
      <path
        d="M16 14.4c-2.2-1.8-4.2-3.4-4.2-5.4a3.8 3.8 0 0 1 7.6 0h-1.6a2.2 2.2 0 0 0-4.4 0c0 1.2 1.6 2.5 3.4 4 .2.15.4.3.6.45Z"
        fill="url(#ef-grad)"
        opacity="0"
      />
      <path
        d="M10 11c0-3.3 2.7-6 6-6s6 2.7 6 6c0 2.4-1.6 4.2-3.2 5.6L16 19l-2.8-2.4C11.6 15.2 10 13.4 10 11Zm6-3.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z"
        fill="url(#ef-grad)"
        opacity="0"
      />
      {/* Infinity / figure-eight symbol */}
      <path
        d="M8.5 16c0-2.5 2-4.5 4.5-4.5 1.7 0 3 .9 3 .9L16 12.4l.9-.5s1.4-.9 3-.9a4.5 4.5 0 0 1 0 9c-1.7 0-3-.9-3-.9l-.9-.5-.9.5s-1.4.9-3 .9c-2.5 0-4.5-2-4.5-4.5Zm4.5-2.5a2.5 2.5 0 0 0 0 5c.9 0 1.7-.5 2.1-.8L16 17l.9.7c.4.3 1.2.8 2.1.8a2.5 2.5 0 0 0 0-5c-.9 0-1.7.5-2.1.8L16 15l-.9-.7c-.4-.3-1.2-.8-2.1-.8Z"
        fill="url(#ef-grad)"
      />
    </svg>
  );
}

export function EightForgeWordmark() {
  return (
    <div className="flex items-center gap-2.5">
      <EightForgeLogo size={28} />
      <span className="text-[13px] font-semibold tracking-wider text-[#F5F7FA]">
        EightForge
      </span>
    </div>
  );
}
