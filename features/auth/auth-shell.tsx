import { ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';

import { Card, CardContent, CardHeader } from '@/components/ui';
import { DEMO_DISCLAIMER } from '@/lib/constants';

/**
 * Auth shell — docs/04_UI_UX_DESIGN_SPECIFICATION.md §13.4.
 *
 * Centred card, single column, no app chrome. This component owns the single
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
  /** `mt-[10vh]` is the spec default for /login and /forgot-password. */
  offset?: boolean;
  children: ReactNode;
}) {
  return (
    <main id="main-content" className="flex flex-1 flex-col focus:outline-none" tabIndex={-1}>
      <div className={`mx-auto flex w-full ${width} flex-1 flex-col px-5 pt-10 pb-6 sm:px-6 ${offset ? 'mt-[10vh]' : ''}`}>
        <div className="mb-6 flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-control bg-accent text-on-solid">
            <ShieldCheck className="size-4" aria-hidden="true" />
          </span>
          <span className="text-sm font-semibold text-primary">CareGrid AI</span>
        </div>

        <Card>
          <CardHeader>
            <h1 className="text-xl font-semibold text-primary">{title}</h1>
            {description ? (
              <p className="max-w-[72ch] text-sm text-secondary">{description}</p>
            ) : null}
          </CardHeader>
          <CardContent className="flex flex-col gap-4 pt-0 pb-5">{children}</CardContent>
        </Card>
      </div>

      <div className="mx-auto w-full max-w-[440px] px-5 pb-8 sm:px-6">
        <p className="text-xs text-muted">{DEMO_DISCLAIMER}</p>
      </div>
    </main>
  );
}
