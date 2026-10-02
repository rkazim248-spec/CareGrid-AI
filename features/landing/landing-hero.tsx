import Link from 'next/link';
import { Activity, ArrowDown, FileCheck2, MapPin, ShieldCheck, Siren, Sparkles, UsersRound } from 'lucide-react';

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
    <section className="grid min-h-[min(720px,calc(100dvh-4rem))] items-center gap-10 py-12 md:grid-cols-[minmax(0,1.08fr)_minmax(320px,0.92fr)] md:gap-14 md:py-16">
      <div className="flex flex-col items-start gap-7">
        <p className="inline-flex min-h-8 items-center gap-2 rounded-pill border border-selected bg-accent-muted px-3 text-xs font-semibold text-accent-fg-muted">
          <ShieldCheck aria-hidden="true" className="size-4" />
          Community incident coordination
        </p>
        <div className="flex flex-col gap-4">
          <h1 className="max-w-[14ch] text-balance text-4xl leading-[1.08] font-bold tracking-tight text-primary sm:text-5xl lg:text-6xl">
            {LANDING.headline}
          </h1>
          <p className="max-w-[52ch] text-base leading-7 text-secondary sm:text-lg">
            {LANDING.subline}
          </p>
        </div>

        <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
          <Button asChild variant="primary" size="lg" className="w-full sm:w-auto">
            <Link href="/report">
              <Siren aria-hidden="true" />
              Report an Emergency
            </Link>
          </Button>
          <Button asChild variant="outline" size="lg" className="w-full sm:w-auto">
            <Link href="#how-it-works">
              Explore CareGrid AI
              <ArrowDown aria-hidden="true" />
            </Link>
          </Button>
        </div>
        <p className="max-w-[54ch] text-sm leading-6 text-muted">
          CareGrid AI does not contact emergency services. Call your local emergency number first
          when someone needs urgent help.
        </p>
      </div>

      <div className="relative mx-auto w-full max-w-xl">
        <div aria-hidden="true" className="absolute -inset-4 -z-10 rounded-[2rem] bg-accent-muted/60" />
        <div className="overflow-hidden rounded-[1.5rem] border border-default bg-surface shadow-[0_24px_70px_-42px_rgba(11,95,255,0.42)]">
          <div className="flex items-center justify-between border-b border-subtle px-5 py-4 sm:px-6">
            <div>
              <p className="text-sm font-semibold text-primary">From report to response</p>
              <p className="mt-1 text-xs text-secondary">One clear, reviewable flow</p>
            </div>
            <span className="flex size-10 items-center justify-center rounded-control bg-accent text-on-solid">
              <Activity aria-hidden="true" className="size-5" />
            </span>
          </div>
          <ol className="grid gap-0 px-5 py-2 sm:px-6">
            {[
              { label: 'Emergency report', icon: Siren },
              { label: 'AI triage for review', icon: Sparkles },
              { label: 'Location context', icon: MapPin },
              { label: 'Saved incident', icon: FileCheck2 },
              { label: 'Community response', icon: UsersRound },
              { label: 'Status tracking', icon: Activity },
            ].map((step, index, steps) => {
              const Icon = step.icon;
              return (
                <li key={step.label} className="flex min-h-[58px] items-center gap-4">
                  <span className="relative flex size-9 shrink-0 items-center justify-center rounded-full border border-default bg-app text-accent">
                    <Icon aria-hidden="true" className="size-4" />
                    {index < steps.length - 1 ? (
                      <span aria-hidden="true" className="absolute top-9 left-1/2 h-5 w-px -translate-x-1/2 bg-default" />
                    ) : null}
                  </span>
                  <span className="text-sm font-medium text-primary">{step.label}</span>
                  {index === 0 ? (
                    <span className="ml-auto rounded-pill bg-danger-muted px-2.5 py-1 text-xs font-semibold text-danger-fg-muted">
                      Start here
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>
          <div className="mx-5 mb-5 rounded-control border border-warning/40 bg-warning-muted px-4 py-3 sm:mx-6">
            <p className="text-sm font-semibold text-warning-fg-muted">Human review stays central</p>
            <p className="mt-1 text-xs leading-5 text-warning-fg-muted">
              AI output is advisory. A report is not a substitute for emergency services.
            </p>
          </div>
        </div>
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
    <section id="how-it-works" className="scroll-mt-20 border-t border-subtle py-16 sm:py-20">
      <div className="mb-9 max-w-2xl">
        <h2 className="text-3xl font-semibold tracking-tight text-primary sm:text-4xl">{LANDING.howItWorksTitle}</h2>
        <p className="mt-3 text-base leading-7 text-secondary">{LANDING.howItWorksLead}</p>
      </div>

      <ol className="grid gap-x-12 gap-y-8 md:grid-cols-2">
        {HOW_IT_WORKS.map((step) => {
          const Icon = step.icon;
          return (
            <li key={step.id} className="flex gap-4 border-l-2 border-selected pl-4 sm:pl-5">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-accent-muted text-accent">
                <Icon className="size-5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-primary">{step.label}</h3>
                <p className="mt-1 text-sm leading-6 text-secondary">{step.description}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
