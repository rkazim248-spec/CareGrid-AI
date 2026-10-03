import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';

import 'mapbox-gl/dist/mapbox-gl.css';
import '@/app/styles/globals.css';
import { AppProviders } from '@/components/providers/app-providers';
import { DemoAvailabilityNotice } from '@/components/feedback/demo-availability-notice';

export const metadata: Metadata = {
  title: {
    default: 'CareGrid AI',
    template: '%s | CareGrid AI',
  },
  description:
    'CareGrid AI turns an unstructured community incident report into a located, deduplicated incident that a dispatcher and a verified community responder can act on.',
  applicationName: 'CareGrid AI',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0B1220' },
    { media: '(prefers-color-scheme: light)', color: '#F5F7FB' },
  ],
  width: 'device-width',
  initialScale: 1,
  // NOT user-scalable=no: pinch-zoom must keep working (WCAG 1.4.4).
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  /**
   * ---------------------------------------------------------------------------
   * WHY THIS READS `headers()` — AND WHY IT IS NOT OPTIONAL
   * ---------------------------------------------------------------------------
   * Two things happen here, and the second is the one that matters.
   *
   * 1. It makes the per-request nonce reachable, so any component that must
   *    render an inline `<script>` can attach `nonce={nonce}` rather than
   *    pressuring anyone into `'unsafe-inline'`. Nothing needs it today; it is
   *    here so that adding one has an obvious, safe answer.
   *
   * 2. Calling `headers()` opts this layout into DYNAMIC rendering, and that is
   *    the fix for the page that hung on "Loading…".
   *
   *    A per-request nonce cannot be baked into static HTML. Next.js therefore
   *    prerenders a route at BUILD time when it believes the route is static —
   *    at which point there is no request, and so no nonce exists. `next start`
   *    then serves that cached `.html` straight from disk WITHOUT re-rendering,
   *    while the middleware still attaches a fresh CSP header carrying a fresh
   *    nonce to the response.
   *
   *    The document then contains scripts with NO nonce, the header names a
   *    nonce that appears nowhere in the document, and — because
   *    `'strict-dynamic'` makes browsers ignore `'self'` and every host
   *    allowlist in `script-src` — the entire client bundle is refused. The page
   *    keeps the server-rendered shell forever: no hydration, permanent spinner.
   *
   *    Measured on this build: 9 routes were prerendered to `.next/server/app/<route>.html`
   *    (`signup`, `dashboard`, `report`, `admin`, …) while `login` was not. The
   *    prerendered ones loaded with 0 CSP violations in the browser and the
   *    rendered ones with 47. One `headers()` call removes that entire class of
   *    bug, because every route is now rendered per request with a nonce that
   *    genuinely matches its own scripts.
   *
   *    The cost is real and worth stating: static generation is off app-wide.
   *    That is correct for this product — every page is behind authentication
   *    and per-user — and it is not negotiable while the policy uses nonces.
   *
   * The nonce VALUE is not read here: Next.js stamps it onto its own bootstrap
   * scripts itself, and this app renders no inline `<script>`. Any component
   * that later needs one reads the same value from the `x-nonce` request
   * header the middleware sets. What this call must do is mark the tree
   * dynamic, so it is invoked for that reason alone.
   */
  await headers();

  return (
    <html lang="en" className="light" suppressHydrationWarning>
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
          <DemoAvailabilityNotice />
          {children}
        </AppProviders>
      </body>
    </html>
  );
}
