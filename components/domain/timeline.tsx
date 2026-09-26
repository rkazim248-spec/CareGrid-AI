import * as React from 'react';

import { cn } from '@/lib/cn';
import { Avatar } from '@/components/ui/avatar';
import { formatAbsolute, formatRelative, relativeTimeAriaLabel, toDateTimeAttr } from '@/lib/format';
import { STATUS_META } from '@/config/statuses';
import type { HistoryEvent } from '@/types/domain';

/**
 * Timeline — docs/04 §5.25
 *
 * An ordered list, one item per event. The event label is the accessible name
 * and INCLUDES the from→to transition as text ("Status changed from verified to
 * assigned") — a bare "assigned" is ambiguous in a list of six events.
 *
 * `metadata` renders as visible text, never as a tooltip: a tooltip is not
 * reachable by keyboard and is not announced.
 */
export type TimelineProps = {
  events: readonly HistoryEvent[];
  /** `full` adds the requestId, for the audit log. */
  variant?: 'compact' | 'full';
  className?: string;
};

/** Plain-language event label. Never shows a raw `eventType` code. */
function eventLabel(event: HistoryEvent): string {
  if (event.eventType === 'created') return 'Report received';
  if (event.eventType === 'ai_triaged') return 'Triaged by CareGrid AI';
  if (event.eventType === 'verified') return 'Verified by a dispatcher';
  if (event.eventType === 'assigned') return 'Responder assigned';
  if (event.eventType === 'unassigned') return 'Responder unassigned';
  if (event.eventType === 'merged') return 'Linked to an earlier report';
  if (event.eventType === 'merged_in') return 'A duplicate report was linked here';
  if (event.eventType === 'comment') return 'Note added';
  if (event.eventType === 'false_alarm') return 'Marked as a false alarm';
  if (event.eventType === 'evidence_added') return 'Evidence added';
  if (event.fromStatus && event.toStatus && event.fromStatus !== event.toStatus) {
    return `Status changed from ${STATUS_META[event.fromStatus].label} to ${STATUS_META[event.toStatus].label}`;
  }
  if (event.toStatus) return `Status set to ${STATUS_META[event.toStatus].label}`;
  return 'Update';
}

function nodeClass(event: HistoryEvent): string {
  if (event.eventType === 'ai_triaged') return 'bg-accent';
  if (event.eventType === 'verified') return 'bg-success';
  if (event.eventType === 'assigned') return 'bg-status-assigned';
  if (event.eventType === 'false_alarm') return 'bg-status-false-alarm';
  if (event.toStatus) return 'bg-status-en-route';
  return 'bg-neutral';
}

export function Timeline({ events, variant = 'compact', className }: TimelineProps) {
  if (events.length === 0) {
    return (
      <p className={cn('text-sm text-secondary', className)}>
        No history has been recorded for this incident yet.
      </p>
    );
  }

  return (
    <ol className={cn('relative flex flex-col gap-4 pl-1', className)}>
      {/* The rule is decorative; the list structure carries the sequence. */}
      <span aria-hidden="true" className="absolute top-2 bottom-2 left-[3px] w-px bg-subtle" />

      {events.map((event) => (
        <li key={event.eventId} className="relative flex gap-3 pl-5">
          <span
            aria-hidden="true"
            className={cn('absolute top-1.5 left-0 size-2 rounded-pill', nodeClass(event))}
          />

          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <p className="text-sm font-semibold text-primary">{eventLabel(event)}</p>
              <time
                dateTime={toDateTimeAttr(event.createdAt)}
                title={formatAbsolute(event.createdAt)}
                aria-label={relativeTimeAriaLabel(event.createdAt)}
                className="text-xs text-muted tabular"
              >
                {formatRelative(event.createdAt)}
              </time>
            </div>

            {variant === 'full' ? (
              <div className="flex items-center gap-2">
                <Avatar name={event.actor.displayName} size="xs" />
                <span className="text-xs text-secondary">{event.actor.displayName}</span>
              </div>
            ) : null}

            {event.note ? (
              <p className="max-w-[72ch] rounded-sm border border-subtle bg-inset px-2 py-1.5 text-xs text-secondary">
                {event.note}
              </p>
            ) : null}

            {event.reason ? (
              <p className="text-xs text-muted">
                <span className="uppercase-label mr-1.5 text-muted">Reason</span>
                {event.reason}
              </p>
            ) : null}

            {event.metadata ? (
              <dl className="flex flex-wrap gap-x-4 gap-y-0.5">
                {Object.entries(event.metadata).map(([key, value]) => (
                  <div key={key} className="flex gap-1.5 text-xs">
                    <dt className="text-muted">{humaniseKey(key)}</dt>
                    <dd className="text-secondary tabular">{String(value)}</dd>
                  </div>
                ))}
              </dl>
            ) : null}

            {variant === 'full' ? (
              <p className="font-mono text-2xs text-muted">{event.requestId}</p>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** `slaState` → `SLA state`. Keys are storage names, not UI copy. */
function humaniseKey(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/\bmin\b/g, 'min');
}
