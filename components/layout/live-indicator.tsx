import * as React from 'react';

import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/format';

/**
 * LiveIndicator — docs/04 §8.2 slot 3
 *
 * A filled dot + "Live" + the age of the last snapshot. The dot SHAPE differs
 * between live and offline (filled vs ring) so the state is not carried by
 * colour alone (docs/04 §2.12).
 *
 * Phase 1 has no listener, so the age is pinned to the demo clock. The props
 * are already the ones Phase 8's `useRealtimeIncidents` will drive, so this file
 * does not change when realtime lands.
 */
export type LiveState = 'live' | 'reconnecting' | 'offline' | 'not_live';

const COPY: Record<LiveState, { label: string; textClass: string; dotClass: string }> = {
  live: { label: 'Live', textClass: 'text-success', dotClass: 'bg-success' },
  reconnecting: { label: 'Reconnecting', textClass: 'text-accent', dotClass: 'bg-accent' },
  offline: { label: 'Offline', textClass: 'text-warning', dotClass: 'border border-warning' },
  not_live: { label: 'Not live', textClass: 'text-muted', dotClass: 'border border-muted' },
};

export function LiveIndicator({
  state = 'live',
  asOfIso = '2026-09-26T10:12:00.000Z',
  className,
}: {
  state?: LiveState;
  asOfIso?: string;
  className?: string;
}) {
  const copy = COPY[state];

  return (
    <p
      className={cn('hidden items-center gap-1.5 text-xs sm:flex', copy.textClass, className)}
      title="Live update status"
    >
      <span aria-hidden="true" className={cn('size-2 rounded-pill', copy.dotClass)} />
      <span className="font-medium">{copy.label}</span>
      {state === 'live' ? (
        <span className="text-muted tabular">· {formatRelative(asOfIso)}</span>
      ) : null}
      <span className="sr-only">
        {state === 'live'
          ? 'Live updates are connected.'
          : state === 'offline'
            ? 'You are offline. This is the last data received.'
            : 'Live updates are not connected.'}
      </span>
    </p>
  );
}
