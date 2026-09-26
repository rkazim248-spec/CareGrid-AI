import { ShieldAlert } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/feedback/error-state';
import { RoleBadge } from '@/components/domain/role-badge';
import { ROLE_META } from '@/config/roles';
import type { ActorRole, UserRole } from '@/types/enums';

/**
 * ForbiddenState — docs/04 §9.6, §13.22
 *
 * RENDERED IN PLACE. Never a redirect, never a loop. The URL stays, the address
 * bar is truthful, and the Back button behaves (docs/04 §13.22).
 *
 * The copy says "no access", not "403": the number means nothing to a citizen.
 * The server code appears in mono beneath, for support only.
 */
export function ForbiddenState({
  role,
  allowedRoles,
  code = 'FORBIDDEN',
  onGoHome,
  onSignOut,
  onViewReports,
  className,
}: {
  role: ActorRole;
  allowedRoles: readonly UserRole[];
  code?: string;
  onGoHome?: () => void;
  onSignOut?: () => void;
  onViewReports?: () => void;
  className?: string;
}) {
  const allowedList = allowedRoles.map((r) => ROLE_META[r].label).join(', ');

  return (
    <div className={cn('mx-auto w-full max-w-2xl px-4 py-16', className)}>
      <ErrorState
        icon={ShieldAlert}
        title="You do not have access to this page"
        description={
          <span className="flex flex-wrap items-center justify-center gap-2">
            <span>You are signed in as</span>
            <RoleBadge role={role} size="md" />
            <span>. This page is for {allowedList}.</span>
          </span>
        }
        code={code}
      />
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        {onGoHome ? (
          <Button variant="secondary" onClick={onGoHome}>
            Go to {ROLE_META[role].landing === '/' ? 'the start page' : 'my dashboard'}
          </Button>
        ) : null}
        {onSignOut ? (
          <Button variant="ghost" onClick={onSignOut}>
            Sign out
          </Button>
        ) : null}
        {onViewReports ? (
          <Button variant="link" onClick={onViewReports}>
            View my reports
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * NotFoundState — docs/04 §9.7
 *
 * For an incident reference, the copy is deliberately IDENTICAL whether the
 * reference does not exist or exists but the caller may not see it. A
 * different message for the two cases turns the page into an existence oracle
 * (US-005 AC4).
 * The actions are plain anchors, not buttons with handlers. A 404 is rendered
 * from a Server Component, and a navigation link does not need client
 * JavaScript — only `ForbiddenState`, which has real in-page behaviour, is
 * interactive.
 */
export function NotFoundState({
  variant = 'page',
  homeHref = '/',
  trackHref = '/track',
  className,
}: {
  variant?: 'page' | 'reference';
  homeHref?: string;
  trackHref?: string;
  className?: string;
}) {
  const isReference = variant === 'reference';
  return (
    <div className={cn('mx-auto w-full max-w-2xl px-4 py-16', className)}>
      <ErrorState
        icon={ShieldAlert}
        title={isReference ? 'We could not find that reference' : 'We could not find that page'}
        description={
          isReference
            ? 'Check the reference and try again. If the report is yours, it will appear under My reports.'
            : 'The link may be out of date. If you were looking for a report, search for its reference instead.'
        }
      />
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <Button asChild variant="secondary">
          <a href={homeHref}>Go to home</a>
        </Button>
        {isReference ? (
          <Button asChild variant="ghost">
            <a href={trackHref}>Look up a report</a>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
