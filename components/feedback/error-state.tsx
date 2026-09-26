import * as React from 'react';
import { OctagonAlert, RefreshCw, WifiOff } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { REQUEST_ID_PATTERN } from '@/lib/constants';

/**
 * ErrorState — docs/04 §5.23
 *
 * NEVER renders a stack trace, an internal error string, a Firestore path, or
 * an HTTP status a user cannot act on. Only the `error.code` catalogue name
 * appears, in mono, so it can be quoted to support.
 */
export type ErrorStateProps = {
  title?: string;
  description: React.ReactNode;
  /** The catalogue code, e.g. `DB_UNAVAILABLE`. Shown in mono for support. */
  code?: string;
  requestId?: string;
  onRetry?: () => void;
  retryLabel?: string;
  secondaryAction?: { label: string; onClick?: () => void; href?: string };
  icon?: LucideIcon;
  className?: string;
};

export function ErrorState({
  title = 'Something went wrong',
  description,
  code,
  requestId,
  onRetry,
  retryLabel = 'Try again',
  secondaryAction,
  icon,
  className,
}: ErrorStateProps) {
  const Icon = icon ?? (code === 'NETWORK' ? WifiOff : OctagonAlert);

  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center gap-3 rounded-card border border-danger bg-danger-muted px-6 py-10 text-center',
        className,
      )}
    >
      <Icon className="size-icon-2xl text-danger" aria-hidden="true" />
      <h3 className="text-lg font-semibold text-danger-fg-muted">{title}</h3>
      <p className="max-w-[52ch] text-sm text-danger-fg-muted opacity-90">{description}</p>

      {requestId || code ? (
        <p className="font-mono text-xs text-danger-fg-muted opacity-80">
          {code ? <span>Reference {code}</span> : null}
          {code && requestId ? ' · ' : null}
          {requestId ? <span>req {requestId}</span> : null}
        </p>
      ) : null}

      <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
        {onRetry ? (
          <Button variant="secondary" onClick={onRetry}>
            <RefreshCw className="size-4" aria-hidden="true" />
            {retryLabel}
          </Button>
        ) : null}
        {secondaryAction ? (
          <Button variant="ghost" onClick={secondaryAction.onClick}>
            {secondaryAction.label}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** The copy table from docs/04 §9.3 so pages cannot invent their own. */
export const ERROR_COPY = {
  generic: {
    title: 'Something went wrong',
    description: 'The page could not be loaded. Your session is still active.',
  },
  readFailed: {
    title: 'We could not load this data',
    description: 'The server did not respond as expected. Nothing has been changed.',
  },
  rateLimited: {
    title: 'Too many requests',
    description: 'You can try again in a moment.',
  },
  network: {
    title: 'You appear to be offline',
    description: 'Actions you take now are kept on this device and sent when the connection returns.',
  },
  forbidden: {
    title: 'You do not have permission for that action',
    description: 'Ask an administrator if you need this.',
  },
  mapFailed: {
    title: 'The map could not load',
    description:
      'A list view with coordinates is shown instead. Every action available on the map is available in the list.',
    retryLabel: 'Retry map',
  },
  notFound: {
    title: 'We could not find that page',
    description: 'The link may be out of date.',
  },
  referenceNotFound: {
    title: 'We could not find that reference',
    description:
      'Check the reference and try again. If the report is yours, it will appear under My reports.',
  },
} as const;

/** A requestId looks like `req_7Kd2mQ9xL4n`. Guard before rendering one. */
export function isRequestIdLike(value: string): boolean {
  return REQUEST_ID_PATTERN.test(value);
}
