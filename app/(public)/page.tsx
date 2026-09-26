import type { Metadata } from 'next';

import { HowItWorks, LandingHero } from '@/features/landing/landing-hero';
import { CoreCapabilities, DemoDisclaimer, TrustSection } from '@/features/landing/landing-sections';

/**
 * `/` — docs/04_UI_UX_DESIGN_SPECIFICATION.md §13.1.
 *
 * Public. Single centred column, `max-w-[720px]`, no sidebar and no top bar.
 * Exactly one `<main>` and exactly one `<h1>` (the hero headline); the public
 * layout owns the wordmark, the sign-in link, and the footer.
 *
 * The health line from `GET /api/health` in the spec is intentionally absent:
 * there is no backend in Phase 1, and a static "System status: ok" would be a
 * claim the build cannot support (docs/04 §1.2 P5).
 */
export const metadata: Metadata = {
  title: 'CareGrid AI — community incident reporting and responder routing',
  description:
    'CareGrid AI turns a community incident report into a located, deduplicated incident that a dispatcher and a verified community responder can act on. A demonstration system, not a replacement for a public emergency number.',
};

export default function Page() {
  return (
    <main id="main-content" className="flex-1 focus:outline-none" tabIndex={-1}>
      <div className="mx-auto w-full max-w-[720px] px-5 pb-4 sm:px-6">
        <LandingHero />
        <DemoDisclaimer />
        <HowItWorks />
        <CoreCapabilities />
        <TrustSection />
      </div>
    </main>
  );
}
