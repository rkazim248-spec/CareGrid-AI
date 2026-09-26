'use client';

import { TooltipProvider } from '@/components/ui/tooltip';
import { ThemeProvider } from '@/components/providers/theme-provider';
import { SessionProvider } from '@/components/providers/session-provider';
import { Toaster } from '@/components/ui/sonner';
import { APP_TIMEZONE } from '@/lib/format';

/**
 * All client-side providers in one place, mounted once by the root layout.
 *
 * The ORDER is load-bearing:
 *
 *   1. **ThemeProvider first.** The Toaster reads the resolved theme for its own
 *      colours, so it must be inside this provider.
 *   2. **SessionProvider next.** It registers the token provider that
 *      `lib/api/client.ts` uses, so nothing may issue an API request above it.
 *   3. **TooltipProvider last**, wrapping everything that can show a tooltip.
 *
 * ---------------------------------------------------------------------------
 * WHY `defaultTimezone` AND NOT `defaultRole`
 * ---------------------------------------------------------------------------
 * Phase 1 took a `defaultRole` prop so all four role shells could be reviewed in
 * one build. Phase 2 removes it: a default role is a mock identity, and the whole
 * point of this phase is that no mock identity survives into a real session. The
 * role now comes only from `GET /api/me`.
 *
 * `defaultTimezone` stays, and it is NOT an identity — it is the IANA timezone a
 * brand-new account is bootstrapped with, and a real value the user can change
 * in Settings.
 */
export function AppProviders({
  children,
  defaultTimezone = APP_TIMEZONE,
}: {
  children: React.ReactNode;
  defaultTimezone?: string;
}) {
  return (
    <ThemeProvider>
      <SessionProvider defaultTimezone={defaultTimezone}>
        <TooltipProvider delayDuration={400} skipDelayDuration={100}>
          {children}
          <Toaster />
        </TooltipProvider>
      </SessionProvider>
    </ThemeProvider>
  );
}
