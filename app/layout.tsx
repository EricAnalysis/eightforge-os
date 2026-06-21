import './globals.css';
import type { Metadata } from 'next';
import { EIGHTFORGE_THEME_STYLE_TEXT } from '@/lib/theme/colors';
import { Analytics } from '@vercel/analytics/next';

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
      <head>
        <style
          id="eightforge-theme"
          dangerouslySetInnerHTML={{ __html: EIGHTFORGE_THEME_STYLE_TEXT }}
        />
      </head>
      <body className="bg-[var(--ef-background-primary)] text-[var(--ef-text-primary)]">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
