import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Sky Bot',
  description: 'Sky Bot — a conversational Telegram bot powered by AICredits (DeepSeek V4.1 Flash).',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
          background: '#0f1115',
          color: '#e6e8eb',
        }}
      >
        {children}
      </body>
    </html>
  );
}
