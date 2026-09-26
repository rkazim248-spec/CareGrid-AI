'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Loader2, ShieldCheck, TriangleAlert, Wrench } from 'lucide-react';

import { useSession } from '@/components/providers/session-provider';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ErrorState, ERROR_COPY } from '@/components/feedback';
import { accountStatusMessage } from '@/components/providers/session-provider';
import { landingFor, describeRole } from '@/lib/auth/roles';
import { APP_TIMEZONE } from '@/lib/format';
import { DEMO_DISCLAIMER } from '@/lib/constants';
import { RoleBadge } from '@/components/domain/role-badge';
import type { Route } from 'next';
import type { AccountStatus, UserRole } from '@/types/enums';

/* ========================================================================== */
/* AuthLoadingScreen                                                           */
/* ========================================================================== */

/**
 * What a person sees while the session resolves.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SKELETON AND NOT A SPINNER
 * ---------------------------------------------------------------------------
 * A centred spinner is a promise that something is happening, and it gives no
 * clue how long. A skeleton that mirrors the shell's real geometry (top bar,
 * sidebar, content column) tells the eye "the layout is about to be this", and
 * it removes the reflow when content arrives. A control room that reshuffles on
 * every load is a control room people stop trusting (docs/04 §9.1).
 *
 * ---------------------------------------------------------------------------
 * COPY
 * ---------------------------------------------------------------------------
 * "Checking your secure session…" — accurate, brief, and it does not promise
 * success. Deliberately NOT "Loading…", which names nothing.
 */
export function AuthLoadingScreen({ label = 'Checking your secure session' }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-dvh flex-col bg-app"
      data-testid="auth-loading"
    >
      <span className="sr-only">{label}</span>

      {/* top bar */}
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-subtle px-3 lg:px-4">
        <div className="skeleton-fill size-7 rounded-control" />
        <div className="skeleton-fill h-3.5 w-24 rounded-sm" />
        <div className="ml-auto flex gap-2">
          <div className="skeleton-fill size-8 rounded-pill" />
          <div className="skeleton-fill size-8 rounded-pill" />
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* sidebar */}
        <div className="hidden w-60 shrink-0 flex-col gap-3 border-r border-subtle p-3 lg:flex">
          {Array.from({ length: 6 }).map((_, index) => (
            <div
              key={index}
              className="skeleton-fill h-9 rounded-control"
              // Widths vary so the block does not read as a table.
              style={{ width: `${100 - index * 8}%` }}
            />
          ))}
        </div>

        {/* content */}
        <div className="flex min-w-0 flex-1 flex-col gap-4 p-4 lg:p-8">
          <div className="skeleton-fill h-8 w-56 rounded-sm" />
          <div className="skeleton-fill h-4 w-96 max-w-full rounded-sm" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="skeleton-fill h-24 rounded-card" />
            ))}
          </div>
          <div className="skeleton-fill h-72 w-full rounded-card" />
        </div>
      </div>
    </div>
  );
}

/* ========================================================================== */
/* Unconfigured notice                                                         */
/* ========================================================================== */

/**
 * Shown when there is no `.env.local`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS AN HONEST PANEL AND NOT A FAKE LOGIN
 * ---------------------------------------------------------------------------
 * A build with no Firebase credentials CANNOT authenticate anyone. The
 * alternative to this panel is a sign-in form that accepts an email and a
 * password and then reports "invalid credentials" for both — which reads as a
 * broken product and sends a reviewer looking for a bug that is not there.
 *
 * So the panel states the cause, the fix, and the file to edit. No placeholder
 * API key is shipped, on purpose: a fake key produces a Firebase error that
 * looks exactly like a network fault (docs/21 §6).
 */
export function FirebaseUnconfiguredNotice({ problem }: { problem: string }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col justify-center gap-4 px-4">
      <div className="rounded-card border border-warning bg-warning-muted px-5 py-4">
        <h1 className="flex items-center gap-2 text-lg font-semibold text-warning-fg-muted">
          <Wrench className="size-icon-md shrink-0" aria-hidden="true" />
          Firebase is not configured
        </h1>
        <p className="mt-2 max-w-[60ch] text-sm text-warning-fg-muted">{problem}</p>
        <ol className="mt-3 list-inside list-decimal space-y-1 text-sm text-warning-fg-muted">
          <li>
            Copy <code className="font-mono text-xs">.env.example</code> to{' '}
            <code className="font-mono text-xs">.env.local</code>
          </li>
          <li>
            Fill in the <code className="font-mono text-xs">NEXT_PUBLIC_FIREBASE_*</code> values
            from Project settings → Your apps in the Firebase console
          </li>
          <li>
            Add the server values too:{' '}
            <code className="font-mono text-xs">FIREBASE_PROJECT_ID</code>,{' '}
            <code className="font-mono text-xs">FIREBASE_CLIENT_EMAIL</code>,{' '}
            <code className="font-mono text-xs">FIREBASE_PRIVATE_KEY</code>
          </li>
          <li>Restart the dev server</li>
        </ol>
      </div>

      <div className="rounded-card border border-default bg-surface px-5 py-4">
        <h2 className="text-sm font-semibold text-primary">
          What still works without a backend
        </h2>
        <p className="mt-1 max-w-[60ch] text-sm text-secondary">
          Every page, layout, and component in this build is real. The dashboards, the incident
          queue, the report form, the map placeholder, the analytics charts, and the admin screens
          all render from typed sample data so the interface can be reviewed now. Signing in is the
          only part that needs Firebase.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button asChild variant="secondary">
            <Link href="/">Go to the landing page</Link>
          </Button>
          <Button asChild variant="ghost">
            <Link href="/dashboard">See the operations console</Link>
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted">{DEMO_DISCLAIMER}</p>
    </main>
  );
}

/* ========================================================================== */
/* RequireSession                                                              */
/* ========================================================================== */

/**
 * The authenticated-route gate.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES AND DOES NOT PROTECT
 * ---------------------------------------------------------------------------
 * It PROTECTS: a signed-out person never sees a half-rendered operations
 * console, and the intended path is preserved so they arrive where they meant
 * to go.
 *
 * It does NOT protect anything. It reads the browser's own session, so anyone
 * can bypass it by editing client state — and they will see buttons that the
 * API then rejects with `403`. That is the correct division of labour: this
 * component is a redirect convenience (docs/05 §9.2), and the real boundary is
 * `requireUser()` plus `firestore.rules`.
 *
 * Written this way on purpose, because the alternative — pretending the client
 * gate is a security boundary — is the failure mode the Phase 2 brief calls out.
 *
 * ---------------------------------------------------------------------------
 * WHY THE REDIRECT WAITS FOR A PAINT
 * ---------------------------------------------------------------------------
 * Calling `router.replace()` during render produces a Next.js warning and, worse,
 * flashes the protected content for one frame. `useEffect` runs after paint, so
 * the skeleton is what a signed-out person sees.
 */
export function RequireSession({
  children,
  requiredRoles,
}: {
  children: React.ReactNode;
  /**
   * Optional role gate. A role mismatch renders `ForbiddenState` IN PLACE —
   * never a redirect, because a redirect from a forbidden URL to a forbidden URL
   * is the loop docs/05 §13.22 forbids.
   */
  requiredRoles?: readonly UserRole[];
}) {
  const { authStatus, configurationProblem, isAuthenticated, role, isAccountBlocked, error, signOut, user } =
    useSession();
  const router = useRouter();
  const pathname = usePathname();

  // Remember where they were going, so sign-in can return them there.
  const nextPath = React.useMemo(() => {
    if (typeof window === 'undefined') return pathname;
    const search = window.location.search;
    return search ? `${pathname}${search}` : pathname;
  }, [pathname]);

  React.useEffect(() => {
    if (authStatus !== 'signed-out') return;
    const target = `/login?next=${encodeURIComponent(nextPath)}`;
    if (window.location.pathname + window.location.search !== target) {
      router.replace(target as Route);
    }
  }, [authStatus, nextPath, router]);

  if (configurationProblem !== null) {
    return <FirebaseUnconfiguredNotice problem={configurationProblem} />;
  }

  if (authStatus === 'initialising' || authStatus === 'loading-profile') {
    return <AuthLoadingScreen />;
  }

  if (authStatus === 'signed-out') {
    // The redirect is in flight. A skeleton rather than a blank page, because a
    // blank white screen is the exact failure the acceptance criteria forbid.
    return <AuthLoadingScreen label="Taking you to the sign-in page" />;
  }

  if (authStatus === 'error') {
    return <SessionErrorState message={error?.message ?? ERROR_COPY.generic.description} onSignOut={signOut} />;
  }

  // Signed in, but the account is not `active`. Show WHY, in this role's own
  // words, rather than the generic "not available" (docs/10 §3.5).
  if (isAccountBlocked && user) {
    return (
      <AccountBlockedState
        status={user.status}
        displayName={user.displayName}
        onSignOut={signOut}
      />
    );
  }

  if (!isAuthenticated) {
    return <AuthLoadingScreen />;
  }

  if (requiredRoles && role && !requiredRoles.includes(role)) {
    return (
      <ForbiddenInPlace
        role={role}
        allowedRoles={requiredRoles}
        landing={landingFor(role)}
      />
    );
  }

  return <>{children}</>;
}

/* ========================================================================== */
/* Forbidden in place                                                          */
/* ========================================================================== */

/**
 * A role mismatch, rendered where the user is.
 *
 * The URL is preserved so the address bar stays truthful, and there is no
 * redirect at all. docs/05 §9.5 gives the copy; the `Refresh session` action is
 * the documented response to a `ROLE_MISMATCH`, which is a different condition
 * from a plain 403 and is handled by `RoleGate` below.
 */
function ForbiddenInPlace({
  role,
  allowedRoles,
  landing,
}: {
  role: UserRole;
  allowedRoles: readonly UserRole[];
  landing: string;
}) {
  const allowedList = allowedRoles.map(describeRole).join(' or ');
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-16">
      <ErrorState
        icon={ShieldCheck}
        title="You do not have access to this page"
        description={
          <span className="flex flex-wrap items-center justify-center gap-2">
            <span>You are signed in as</span>
            <RoleBadge role={role} size="md" />
            <span>. This page is for {allowedList}.</span>
          </span>
        }
      />
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <Button asChild variant="secondary">
          {/* `Link`, not `<a>`: this is an in-app navigation, and a full page
              load would re-run the whole auth boot sequence. */}
          <Link href={landing as Route}>Go to my start page</Link>
        </Button>
      </div>
    </main>
  );
}

/* ========================================================================== */
/* Account blocked                                                             */
/* ========================================================================== */

/**
 * `status !== 'active'`. Each state gets its own sentence, because this screen is
 * read by someone who has just been told they cannot get in and needs to know
 * whether that is temporary, permanent, or someone else's decision.
 */
function AccountBlockedState({
  status,
  displayName,
  onSignOut,
}: {
  status: AccountStatus;
  displayName: string;
  onSignOut: () => void;
}) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col justify-center px-4">
      <ErrorState title="This account is not available" description={accountStatusMessage(status)} />
      <div className="mt-4 flex flex-col items-center gap-3">
        <p className="text-sm text-muted">Signed in as {displayName}</p>
        <Button variant="secondary" onClick={onSignOut}>
          Sign out
        </Button>
      </div>
    </main>
  );
}

/* ========================================================================== */
/* Session error                                                               */
/* ========================================================================== */

/**
 * The session exists but `/api/me` failed.
 *
 * A Retry is offered, because the most common cause is a transient network
 * failure and the second is a misconfigured server — both worth one more try. A
 * Sign out is offered because a person whose profile will not load has no way
 * to clear local state otherwise.
 */
function SessionErrorState({ message, onSignOut }: { message: string; onSignOut: () => void }) {
  const { refreshMe } = useSession();
  const [isRetrying, setIsRetrying] = React.useState(false);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col justify-center px-4">
      <ErrorState
        title={ERROR_COPY.readFailed.title}
        description={message}
        onRetry={() => {
          setIsRetrying(true);
          void refreshMe().finally(() => setIsRetrying(false));
        }}
        retryLabel={isRetrying ? 'Retrying' : 'Try again'}
      />
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <Button variant="secondary" onClick={onSignOut}>
          Sign out
        </Button>
      </div>
    </main>
  );
}

/* ========================================================================== */
/* RoleGate — for a route with its own role requirement                        */
/* ========================================================================== */

/**
 * Wraps a page that has a role requirement declared at the page level rather
 * than in a layout (docs/05 §9.3 "route-level overrides").
 *
 * The Phase 2 examples: `/analytics` is dispatcher-or-admin, `/map` and
 * `/responders` are not open to a citizen.
 *
 * While the session is still resolving it renders a SKELETON, not the children.
 * The alternative — rendering the page and hiding the parts the role cannot
 * use — flashes a dispatcher console at a citizen, which is both a leak of
 * layout information and a bad first impression if they were a dispatcher whose
 * session had not loaded yet.
 */
export function RoleGate({
  children,
  allowed,
}: {
  children: React.ReactNode;
  allowed: readonly UserRole[];
}) {
  const { authStatus, role, configurationProblem } = useSession();

  if (configurationProblem !== null) {
    return <FirebaseUnconfiguredNotice problem={configurationProblem} />;
  }

  if (authStatus === 'initialising' || authStatus === 'loading-profile' || role === null) {
    return <AuthLoadingScreen label="Checking your access" />;
  }

  if (!allowed.includes(role)) {
    return <ForbiddenInPlace role={role} allowedRoles={allowed} landing={landingFor(role)} />;
  }

  return <>{children}</>;
}

/* ========================================================================== */
/* SessionRefreshPrompt                                                        */
/* ========================================================================== */

/**
 * The documented response to a `403 ROLE_MISMATCH` (docs/05 §9.5): a calm
 * notice with an EXPLICIT refresh action.
 *
 * A role change takes effect on the next token refresh, and that refresh is
 * always user-triggered. Refreshing silently could change the UI under an
 * operator who is part-way through a decision — so the product says what
 * happened and lets the person act.
 */
export function SessionRefreshPrompt({ onRefresh }: { onRefresh: () => Promise<void> }) {
  const [isRefreshing, setIsRefreshing] = React.useState(false);

  return (
    <Alert tone="warning" role="status">
      <TriangleAlert className="mt-px size-icon-md shrink-0" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <AlertTitle>Your access level has changed</AlertTitle>
        <AlertDescription>
          An administrator updated your permissions. Refresh your session to see them.
        </AlertDescription>
        <div>
          <Button
            variant="secondary"
            size="sm"
            loading={isRefreshing}
            onClick={() => {
              setIsRefreshing(true);
              void onRefresh().finally(() => setIsRefreshing(false));
            }}
          >
            Refresh session
          </Button>
        </div>
      </div>
    </Alert>
  );
}

/** A bare spinner, for a button that needs one inline. */
export function InlineSpinner({ className }: { className?: string }) {
  return (
    <Loader2
      className={className ?? 'size-4 animate-[var(--animate-spin-slow)] motion-reduce:animate-none'}
      aria-hidden="true"
    />
  );
}

export { APP_TIMEZONE };
