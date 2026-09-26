import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';

import { FOOTER_PRODUCT_LINKS, LANDING } from '@/features/landing/landing-copy';
import type { FooterLink } from '@/features/landing/landing-copy';
import { DEMO_DISCLAIMER } from '@/lib/constants';

/**
 * Public chrome — docs/04_UI_UX_DESIGN_SPECIFICATION.md §8.6.
 *
 * NO sidebar and NO top bar on a public route. The wordmark is a `<span>`, not
 * an `<h1>`: the page owns the single document heading, and two h1s on one route
 * is an outline defect rather than a style choice.
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-app">
      <header className="border-b border-subtle bg-app">
        <div className="mx-auto flex w-full max-w-[720px] items-center justify-between gap-4 px-5 py-4 sm:px-6">
          <Link
            href="/"
            className="flex items-center gap-2 rounded-control focus-visible:ring-[2px] focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app focus-visible:outline-none"
          >
            <span className="flex size-7 items-center justify-center rounded-control bg-accent text-on-solid">
              <ShieldCheck className="size-4" aria-hidden="true" />
            </span>
            <span className="text-sm font-semibold text-primary">{LANDING.wordmark}</span>
          </Link>

          <Link
            href="/login"
            className="min-h-11 rounded-control px-2 py-2 text-sm font-medium text-accent underline-offset-4 transition-colors hover:underline focus-visible:ring-[2px] focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app focus-visible:outline-none"
          >
            {LANDING.signIn}
          </Link>
        </div>
      </header>

      {children}

      <PublicFooter />
    </div>
  );
}

/**
 * The footer is deliberately thin: a one-line description, the demo
 * disclaimer, product links, and one contact address. No social links that go
 * nowhere and no partner logos (docs/04 §1.3 A1, §15.5).
 */
function PublicFooter() {
  return (
    <footer className="mt-12 border-t border-subtle bg-app">
      <div className="mx-auto w-full max-w-[720px] px-5 py-10 sm:px-6">
        <div className="grid gap-8 sm:grid-cols-3">
          <section className="flex flex-col gap-2">
            <p className="text-sm font-semibold text-primary">{LANDING.wordmark}</p>
            <p className="text-sm text-secondary">{LANDING.footerAbout}</p>
            <p className="text-xs text-muted">{DEMO_DISCLAIMER}</p>
          </section>

          <FooterColumn title="Product" links={FOOTER_PRODUCT_LINKS} />

          <section className="flex flex-col gap-2">
            <h2 className="uppercase-label text-muted">{LANDING.footerContactLead}</h2>
            <a
              href={`mailto:${LANDING.mailto}`}
              className="min-h-11 self-start text-sm text-accent underline-offset-4 hover:underline focus-visible:ring-[2px] focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app focus-visible:outline-none"
            >
              {LANDING.mailto}
            </a>
            <p className="text-xs text-secondary">{LANDING.footerContactNote}</p>
          </section>
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({ title, links }: { title: string; links: readonly FooterLink[] }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="uppercase-label text-muted">{title}</h2>
      <ul className="flex flex-col gap-1">
        {links.map((link) => (
          <li key={link.label}>
            <Link
              href={link.href}
              className="inline-flex min-h-11 items-center text-sm text-secondary transition-colors hover:text-primary focus-visible:ring-[2px] focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app focus-visible:outline-none"
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
