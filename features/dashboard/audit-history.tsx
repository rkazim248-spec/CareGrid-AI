'use client';

import * as React from 'react';
import { ScrollText } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui';
import { RequestId } from '@/components/feedback';
import { RelativeTime } from '@/components/domain';
import { MOCK_HISTORY_BY_INCIDENT } from '@/lib/mock-data';
import { STATUS_META } from '@/config';
import type { HistoryEvent, HistoryEventType, Incident } from '@/types';

/**
 * AuditHistory — the last three entries of the incident's history with their
 * `requestId` and a copy control (docs/04 §5.28, §13.9).
 *
 * The `requestId` is the thing a person quotes to support. It is rendered in
 * mono, always visible, and copyable — a tooltip is not a correlation id, and a
 * correlation id in a tooltip cannot be selected (docs/04 §5.19).
 *
 * The `Timeline` component owns the long form; this block exists because the
 * detail panel needs a compact, auditable strip that fits in a side panel.
 */
const MAX_ENTRIES = 3;

/** Plain-language event names. A raw `eventType` code is never shown (docs/04 §5.25). */
const EVENT_LABEL: Record<HistoryEventType, string> = {
  created: 'Report received',
  ai_triaged: 'Triaged by CareGrid AI',
  status_change: 'Status updated',
  verified: 'Verified by a dispatcher',
  assigned: 'Responder assigned',
  unassigned: 'Responder unassigned',
  merged: 'Linked to an earlier report',
  merged_in: 'A duplicate report was linked here',
  comment: 'Note added',
  false_alarm: 'Marked as a false alarm',
  evidence_added: 'Evidence added',
};

export function AuditHistory({
  incident,
  className,
}: {
  incident: Incident;
  className?: string;
}) {
  const history = MOCK_HISTORY_BY_INCIDENT[incident.incidentId] ?? [];
  const recent = history.slice(-MAX_ENTRIES).reverse();

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ScrollText className="size-4 text-muted" aria-hidden="true" />
          Recent audit entries
        </CardTitle>
        <p className="text-xs text-muted">
          Every action on this incident is recorded with a reference you can quote.
        </p>
      </CardHeader>

      <CardContent>
        {recent.length === 0 ? (
          <p className="text-sm text-secondary">No actions have been recorded yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-subtle">
            {recent.map((event) => (
              <AuditRow key={event.eventId} event={event} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function AuditRow({ event }: { event: HistoryEvent }) {
  const transition =
    event.fromStatus && event.toStatus && event.fromStatus !== event.toStatus
      ? `Status changed from ${STATUS_META[event.fromStatus].label} to ${STATUS_META[event.toStatus].label}`
      : null;

  return (
    <li className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <p className="text-sm font-medium text-primary">
          {transition ?? EVENT_LABEL[event.eventType]}
        </p>
        <RelativeTime iso={event.createdAt} />
      </div>
      <p className="text-xs text-secondary">{event.actor.displayName}</p>
      {event.reason ? <p className="text-xs text-muted">Reason: {event.reason}</p> : null}
      <div className="flex items-center gap-2">
        <RequestId value={event.requestId} />
      </div>
    </li>
  );
}
