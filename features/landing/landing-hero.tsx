import Link from 'next/link';

import { Button } from '@/components/ui';
import { HOW_IT_WORKS, LANDING } from '@/features/landing/landing-copy';

/**
 * Landing hero — docs/04 §13.1.
 *
 * ONE `<h1>` in the document, and it is the headline. The wordmark in the public
 * layout is deliberately a span so the outline stays valid.
 *
 * Mobile: hero text `text-2xl`, buttons full width and stacked, primary FIRST
 * (docs/04 §13.1 mobile rule and §5.1 "w-full is the default on mobile").
 */
export function LandingHero() {
  return (
    <section className="flex flex-col gap-6 pt-10 sm:pt-14">
      <div className="flex flex-col gap-3">
        <h1 className="max-w-[20ch] text-2xl leading-tight font-bold text-primary sm:text-4xl">
          {LANDING.headline}
        </h1>
        <p className="max-w-[72ch] text-base text-secondary">{LANDING.subline}</p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Button asChild variant="primary" size="lg" className="w-full sm:w-auto">
          <Link href="/signup">{LANDING.createAccount}</Link>
        </Button>
        <Button asChild variant="outline" size="lg" className="w-full sm:w-auto">
          <Link href="/login">{LANDING.signIn}</Link>
        </Button>
      </div>
    </section>
  );
}

/**
 * "How it works" — a four-step vertical flow.
 *
 * The step marker is chip-shaped like `UrgencyBadge` so the flow reads at a
 * glance, but it uses the neutral accent tint rather than any urgency token:
 * this is marketing copy, and borrowing the operational severity palette here
 * would be a lie about what is happening (docs/04 §1.3 A2).
 */
export function HowItWorks() {
  return (
    <section id="how-it-works" className="flex scroll-mt-20 flex-col gap-5 pt-12">
      <div className="flex flex-col gap-1.5">
        <h2 className="text-xl font-semibold text-primary">{LANDING.howItWorksTitle}</h2>
        <p className="max-w-[72ch] text-sm text-secondary">{LANDING.howItWorksLead}</p>
      </div>

      <ol className="flex flex-col gap-4">
        {HOW_IT_WORKS.map((step, index) => {
          const Icon = step.icon;
          return (
            <li key={step.id} className="flex gap-4">
              <div className="flex flex-col items-center gap-2">
                <span className="inline-flex h-8 items-center gap-1.5 rounded-pill border border-accent bg-accent-muted px-3 text-2xs font-semibold tracking-[0.06em] text-accent-fg-muted uppercase">
                  <Icon className="size-3.5" aria-hidden="true" />
                  {step.label}
                </span>
                {index < HOW_IT_WORKS.length - 1 ? (
                  <span aria-hidden="true" className="h-8 w-px bg-subtle" />
                ) : null}
              </div>
              <p className="min-w-0 flex-1 pt-1 text-sm text-secondary">{step.description}</p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
