import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';

import '@/app/styles/globals.css';
import { AppProviders } from '@/components/providers/app-providers';

/**
 * Inter Variable via next/font. Self-hosted, preloaded, with a metric-adjusted
 * fallback so the swap does not cause a layout shift (docs/04 §3.1).
 *
 * The MONO stack is deliberately the SYSTEM mono stack, not a second web font:
 * a reference like `CG-7QK4M2` needs 14 characters of monospace, and a ~30 KB
 * web font to render them would be the single worst bundle decision available
 * here (docs/04 §3.1).
 */
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
  preload: true,
});

export const metadata: Metadata = {
  title: {
    default: 'CareGrid AI',
    template: '%s · CareGrid AI',
  },
  description:
    'CareGrid AI turns an unstructured community incident report into a located, deduplicated incident that a dispatcher and a verified community responder can act on.',
  applicationName: 'CareGrid AI',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0B0F14' },
    { media: '(prefers-color-scheme: light)', color: '#F6F8FA' },
  ],
  width: 'device-width',
  initialScale: 1,
  // NOT user-scalable=no: pinch-zoom must keep working (WCAG 1.4.4).
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body className="min-h-dvh bg-app text-primary antialiased">
        <AppProviders>
          {/* The skip link is the FIRST focusable element in the document
              (docs/30 §4.5). It lives here so no route can displace it. */}
          <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-control focus:bg-accent focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-on-solid"
          >
            Skip to main content
          </a>
          {children}
        </AppProviders>
      </body>
    </html>
  );
}
