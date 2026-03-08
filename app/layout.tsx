// app/layout.tsx
import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'EightForge OS',
  description: 'The operating system for automated decision systems in complex operations.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-[#0F1115] text-[#F1F3F5]">
        {children}
      </body>
    </html>
  );
}
