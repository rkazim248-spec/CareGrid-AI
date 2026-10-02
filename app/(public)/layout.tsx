import Link from 'next/link';

import { CareGridMark } from '@/components/brand/caregrid-mark';
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
      <header className="sticky top-0 z-40 border-b border-subtle bg-surface/95 backdrop-blur">
        <div className="mx-auto flex min-h-16 w-full max-w-7xl items-center justify-between gap-4 px-5 sm:px-8">
          <Link
            href="/"
            className="flex items-center gap-2 rounded-control focus-visible:ring-[2px] focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app focus-visible:outline-none"
          >
            <span className="flex size-9 items-center justify-center rounded-control bg-accent text-on-solid">
              <CareGridMark className="size-5" />
            </span>
            <span className="text-sm font-semibold tracking-tight text-primary">{LANDING.wordmark}</span>
          </Link>

          <nav aria-label="Main" className="flex items-center gap-2 sm:gap-5">
            <Link href="/#how-it-works" className="hidden min-h-11 items-center text-sm text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-focus sm:inline-flex">
              How it works
            </Link>
            <Link href="/#safety" className="hidden min-h-11 items-center text-sm text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-focus sm:inline-flex">
              Safety
            </Link>
            <Link href="/login" className="inline-flex min-h-11 items-center rounded-control px-2 text-sm font-semibold text-primary hover:bg-elevated focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-focus sm:px-3">
              {LANDING.signIn}
            </Link>
            <Link href="/signup" className="inline-flex min-h-11 items-center rounded-control bg-accent px-3 text-sm font-semibold text-on-solid transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app">
              Create account
            </Link>
          </nav>
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
      <div className="mx-auto w-full max-w-7xl px-5 py-10 sm:px-8">
        <div className="grid gap-8 border-t border-subtle pt-8 sm:grid-cols-3">
          <section className="flex flex-col gap-2">
            <p className="text-sm font-semibold text-primary">{LANDING.wordmark}</p>
            <p className="text-sm text-secondary">{LANDING.footerAbout}</p>
            <p className="text-xs text-muted">{DEMO_DISCLAIMER}</p>
          </section>

          <FooterColumn title="Product" links={FOOTER_PRODUCT_LINKS} />

          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-primary">Emergency help</h2>
            <p className="max-w-[42ch] text-sm leading-6 text-secondary">
              CareGrid AI is not an emergency service. Contact your local emergency number when urgent help is needed.
            </p>
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
