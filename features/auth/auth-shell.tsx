import Link from 'next/link';
import { Activity, MapPin, ShieldAlert, Siren, Sparkles, UsersRound } from 'lucide-react';
import type { ReactNode } from 'react';

import { CareGridMark } from '@/components/brand/caregrid-mark';
import { Card, CardContent, CardHeader } from '@/components/ui';
import { DEMO_DISCLAIMER } from '@/lib/constants';

/**
 * Auth shell — docs/04_UI_UX_DESIGN_SPECIFICATION.md §13.4.
 *
 * Responsive split layout, without app chrome. This component owns the single
 * `<main>` and the single `<h1>` for `/login`, `/signup`, and
 * `/forgot-password`, so none of those three routes can disagree about the
 * landmark structure.
 *
 * `width` is per-route because the spec gives different caps: `max-w-[400px]`
 * for sign-in and reset, `max-w-[440px]` for sign-up.
 */
export function AuthShell({
  title,
  description,
  width = 'max-w-[400px]',
  offset = true,
  children,
}: {
  title: string;
  description?: ReactNode;
  width?: string;
  /** Retained for existing route callers; vertical rhythm is handled by the grid. */
  offset?: boolean;
  children: ReactNode;
}) {
  return (
    <main id="main-content" className="flex flex-1 flex-col focus:outline-none" tabIndex={-1}>
      <div className="mx-auto grid w-full max-w-6xl flex-1 items-center gap-8 px-5 py-8 sm:px-8 lg:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)] lg:gap-16 lg:py-12">
        <aside className="hidden min-w-0 flex-col justify-between gap-10 py-8 lg:flex">
          <Link href="/" className="flex w-fit items-center gap-3 rounded-control focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-focus">
            <span className="flex size-11 items-center justify-center rounded-control bg-accent text-on-solid">
              <CareGridMark className="size-6" />
            </span>
            <span className="text-base font-semibold tracking-tight text-primary">CareGrid AI</span>
          </Link>
          <div>
            <h2 className="max-w-[12ch] text-4xl leading-tight font-semibold tracking-tight text-primary xl:text-5xl">
              Keep every detail connected.
            </h2>
            <p className="mt-4 max-w-[48ch] text-base leading-7 text-secondary">
              Report an emergency, add useful context, and follow the saved incident from one place.
            </p>
            <ol className="mt-9 grid gap-4">
              {[
                { label: 'Report the situation', icon: Siren },
                { label: 'Review AI suggestions', icon: Sparkles },
                { label: 'Add location context', icon: MapPin },
                { label: 'Coordinate a response', icon: UsersRound },
              ].map((step, index) => {
                const Icon = step.icon;
                return (
                  <li key={step.label} className="flex items-center gap-3">
                    <span className="flex size-9 items-center justify-center rounded-control border border-default bg-surface text-accent">
                      <Icon aria-hidden="true" className="size-4" />
                    </span>
                    <span className="text-sm font-medium text-secondary">{step.label}</span>
                    {index < 3 ? <Activity className="ml-auto size-4 text-muted" aria-hidden="true" /> : null}
                  </li>
                );
              })}
            </ol>
          </div>
          <div className="flex gap-3 rounded-card border border-danger/25 bg-danger-muted p-4">
            <ShieldAlert className="mt-0.5 size-5 shrink-0 text-danger-fg-muted" aria-hidden="true" />
            <p className="text-sm leading-6 text-danger-fg-muted">
              CareGrid AI does not contact emergency services. Call your local emergency number first when urgent help is needed.
            </p>
          </div>
        </aside>

        <section className={`mx-auto w-full ${width} ${offset ? 'lg:py-4' : ''}`}>
          <div className="mb-5 flex items-center gap-2 lg:hidden">
            <span className="flex size-9 items-center justify-center rounded-control bg-accent text-on-solid">
              <CareGridMark className="size-5" />
            </span>
            <span className="text-sm font-semibold tracking-tight text-primary">CareGrid AI</span>
          </div>
          <Card className="overflow-hidden">
            <CardHeader className="px-5 pt-6 sm:px-7 sm:pt-7">
              <h1 className="text-2xl font-semibold tracking-tight text-primary">{title}</h1>
              {description ? (
                <p className="max-w-[50ch] text-sm leading-6 text-secondary">{description}</p>
              ) : null}
            </CardHeader>
            <CardContent className="flex flex-col gap-4 px-5 pt-2 pb-6 sm:px-7 sm:pb-7">{children}</CardContent>
          </Card>
        </section>
      </div>

      <div className="mx-auto w-full max-w-6xl px-5 pb-6 sm:px-8">
        <p className="text-xs leading-5 text-muted">{DEMO_DISCLAIMER}</p>
      </div>
    </main>
  );
}
