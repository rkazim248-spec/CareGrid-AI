import { Alert, AlertDescription, AlertIcon, AlertTitle, Card, CardContent, CardHeader, CardTitle } from '@/components/ui';
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
    <section className="flex flex-col gap-5 pt-12">
      <div className="flex flex-col gap-1.5">
        <h2 className="text-xl font-semibold text-primary">{LANDING.capabilitiesTitle}</h2>
        <p className="max-w-[72ch] text-sm text-secondary">{LANDING.capabilitiesLead}</p>
      </div>

      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {CAPABILITIES.map((capability) => {
          const Icon = capability.icon;
          return (
            <li key={capability.id}>
              <Card className="h-full">
                <CardHeader>
                  <span className="mb-1 flex size-9 items-center justify-center rounded-control border border-default bg-elevated text-accent">
                    <Icon className="size-icon-lg" aria-hidden="true" />
                  </span>
                  <CardTitle className="text-base">{capability.title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="max-w-[46ch] text-sm text-secondary">{capability.description}</p>
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
    <div className="pt-10">
      <Alert tone="neutral">
        <AlertIcon tone="neutral" />
        <div className="flex min-w-0 flex-col gap-1">
          <AlertTitle>This is a demonstration system</AlertTitle>
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
    <section id="safety" className="flex scroll-mt-20 flex-col gap-5 pt-12">
      <div className="flex flex-col gap-1.5">
        <h2 className="text-xl font-semibold text-primary">{LANDING.trustTitle}</h2>
        <p className="max-w-[72ch] text-sm text-secondary">{LANDING.trustLead}</p>
      </div>

      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {TRUST_POINTS.map((point) => {
          const Icon = point.icon;
          return (
            <li key={point.id}>
              <Card className="h-full">
                <CardHeader>
                  <Icon className="mb-1 size-icon-lg text-secondary" aria-hidden="true" />
                  <CardTitle className="text-base">{point.title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="max-w-[46ch] text-sm text-secondary">{point.body}</p>
                </CardContent>
              </Card>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
