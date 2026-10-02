import Link from 'next/link';
import { ArrowRight, ShieldAlert } from 'lucide-react';

import { Alert, AlertDescription, AlertIcon, AlertTitle, Button, Card, CardContent, CardHeader, CardTitle } from '@/components/ui';
import { CAPABILITIES, LANDING, TRUST_POINTS } from '@/features/landing/landing-copy';
import { DEMO_DISCLAIMER_LONG } from '@/lib/constants';

/**
 * "Core capabilities" — six cards, two columns at `sm`, one on mobile.
 *
 * Each card leads with an `icon-lg` and a sentence that says what the feature
 * does. No gradients, no illustration artwork, no fake metrics (docs/04 §1.3).
 */
export function CoreCapabilities() {
  return (
    <section className="border-t border-subtle py-16 sm:py-20">
      <div className="mb-9 max-w-2xl">
        <h2 className="text-3xl font-semibold tracking-tight text-primary sm:text-4xl">{LANDING.capabilitiesTitle}</h2>
        <p className="mt-3 text-base leading-7 text-secondary">{LANDING.capabilitiesLead}</p>
      </div>

      <ul className="grid grid-cols-1 gap-4 md:grid-cols-12">
        {CAPABILITIES.map((capability, index) => {
          const Icon = capability.icon;
          const span = ['md:col-span-7', 'md:col-span-5', 'md:col-span-5', 'md:col-span-7', 'md:col-span-4', 'md:col-span-8'][index] ?? 'md:col-span-6';
          return (
            <li key={capability.id} className={span}>
              <Card className={`h-full min-h-48 ${index === 0 ? 'bg-accent-muted/50' : ''} ${index === 1 ? 'bg-elevated' : ''}`}>
                <CardHeader className="px-5 pt-5 sm:px-6 sm:pt-6">
                  <span className="mb-1 flex size-10 items-center justify-center rounded-control border border-default bg-surface text-accent">
                    <Icon className="size-icon-lg" aria-hidden="true" />
                  </span>
                  <CardTitle className="text-lg">{capability.title}</CardTitle>
                </CardHeader>
                <CardContent className="px-5 pb-5 sm:px-6 sm:pb-6">
                  <p className="max-w-[52ch] text-sm leading-6 text-secondary">{capability.description}</p>
                </CardContent>
              </Card>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The demo disclaimer, stated once and plainly (docs/04 §15.5). It is a
 * `neutral` Alert, not a `warning` and not a toast: a citizen must never be left
 * believing a report reached a statutory service.
 */
export function DemoDisclaimer() {
  return (
    <div className="py-8">
      <Alert tone="neutral">
        <AlertIcon tone="neutral" />
        <div className="flex min-w-0 flex-col gap-1">
          <AlertTitle>Contact emergency services first</AlertTitle>
          <AlertDescription>{DEMO_DISCLAIMER_LONG}</AlertDescription>
        </div>
      </Alert>
    </div>
  );
}

/**
 * The trust section. It states the limits in the first person: the AI is
 * advisory, a human dispatcher reviews and assigns, and no government,
 * hospital, or emergency service is contacted. Calm, specific, no partnership
 * claim of any kind (docs/04 §15.4, §1.2 P5).
 */
export function TrustSection() {
  return (
    <section id="safety" className="scroll-mt-20 border-t border-subtle py-16 sm:py-20">
      <div className="mb-9 max-w-2xl">
        <h2 className="text-3xl font-semibold tracking-tight text-primary sm:text-4xl">{LANDING.trustTitle}</h2>
        <p className="mt-3 text-base leading-7 text-secondary">{LANDING.trustLead}</p>
      </div>

      <ul className="grid gap-0 border-y border-default md:grid-cols-3">
        {TRUST_POINTS.map((point) => {
          const Icon = point.icon;
          return (
            <li key={point.id} className="flex flex-col gap-3 border-t border-default py-6 first:border-t-0 md:border-t-0 md:border-l md:first:border-l-0 md:px-6 md:first:pl-0 md:last:pr-0">
              <Icon className="size-5 text-accent" aria-hidden="true" />
              <h3 className="text-base font-semibold text-primary">{point.title}</h3>
              <p className="max-w-[46ch] text-sm leading-6 text-secondary">{point.body}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function LandingCallToAction() {
  return (
    <section id="technology" className="border-t border-subtle py-16 sm:py-20">
      <div className="landing-cta-surface grid gap-8 rounded-[1.25rem] px-6 py-8 sm:px-10 sm:py-10 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
        <div className="max-w-2xl">
          <div className="mb-4 flex size-10 items-center justify-center rounded-control bg-white/10 text-white">
            <ShieldAlert aria-hidden="true" className="size-5" />
          </div>
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">A clearer handoff starts with a useful report.</h2>
          <p className="landing-cta-copy mt-3 max-w-[60ch] text-sm leading-6">
            Share what happened, add location context, and return to the saved record for updates.
          </p>
        </div>
        <Button asChild variant="primary" size="lg" className="w-full sm:w-auto">
          <Link href="/signup">
            Create an account
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
      </div>
    </section>
  );
}
