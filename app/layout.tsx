import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'EightForge',
  description:
    'The operating system for automated decision systems in complex operations.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-[#0B1020] text-[#E5EDF7]">
        {children}
      </body>
    </html>
  );
}
