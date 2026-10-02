'use client';

import Link from 'next/link';
import { MapPin, Sparkles } from 'lucide-react';
import type { z } from 'zod';

import { Card, CardContent } from '@/components/ui';
import { RelativeTime, StatusBadge, UrgencyBadge } from '@/components/domain';
import { CATEGORY_META } from '@/config';
import type { incidentListResponseSchema } from '@/validators/incident';

type IncidentRow = z.infer<typeof incidentListResponseSchema>['items'][number];

/**
 * One row in "My reports" — docs/04 §13.8 mobile card list.
 *
 * A card, not a table row. At 360 px a seven-column table is unreadable, and
 * the citizen is the primary phone reader of this route (docs/04 §12.1, §5.16
 * responsive rule). The whole card is the link, so there is one tab stop and
 * one accessible name rather than a link nested inside a row.
 */
export function MyReportCard({ incident }: { incident: IncidentRow }) {
  const category = incident.category ? CATEGORY_META[incident.category].label : 'Not classified';
  const placeName = incident.placeName;

  return (
    <li>
      <Link
        href={`/incidents/${incident.incidentId}`}
        className="block rounded-card focus-visible:ring-[2px] focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app focus-visible:outline-none"
      >
        <Card className="transition-colors hover:border-strong">
          <CardContent className="flex flex-col gap-2 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="ref-code text-xs text-primary">{incident.reference}</span>
              <StatusBadge status={incident.status} size="sm" />
              <UrgencyBadge urgency={incident.urgency} size="sm" />
              {incident.ai ? (
                <span className="inline-flex min-h-7 items-center gap-1.5 rounded-pill border border-selected bg-accent-muted px-2.5 text-xs font-medium text-accent-fg-muted">
                  <Sparkles className="size-3.5" aria-hidden="true" />
                  {incident.ai.source === 'ai'
                    ? 'AI analysis'
                    : incident.ai.source === 'fallback'
                      ? 'Rule-based triage'
                      : incident.ai.source === 'manual'
                        ? 'Manual triage'
                        : 'Triage recorded'}
                </span>
              ) : null}
            </div>

            <p className="clamp-2 max-w-[72ch] text-sm text-primary">{incident.summary}</p>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-secondary">
              <span>{category}</span>
              {placeName ? (
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <MapPin className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">{placeName}</span>
                </span>
              ) : (
                <span className="text-muted">No location on this report</span>
              )}
              {incident.createdAt ? <RelativeTime iso={incident.createdAt.toISOString()} /> : null}
            </div>
          </CardContent>
        </Card>
      </Link>
    </li>
  );
}
