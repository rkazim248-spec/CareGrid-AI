'use client';

import Link from 'next/link';
import { MapPin } from 'lucide-react';

import { Card, CardContent } from '@/components/ui';
import { RelativeTime, StatusBadge, UrgencyBadge } from '@/components/domain';
import { CATEGORY_META } from '@/config';
import type { Incident } from '@/types';

/**
 * One row in "My reports" — docs/04 §13.8 mobile card list.
 *
 * A card, not a table row. At 360 px a seven-column table is unreadable, and
 * the citizen is the primary phone reader of this route (docs/04 §12.1, §5.16
 * responsive rule). The whole card is the link, so there is one tab stop and
 * one accessible name rather than a link nested inside a row.
 */
export function MyReportCard({ incident }: { incident: Incident }) {
  const category = CATEGORY_META[incident.category];
  const CategoryIcon = category.icon;
  const placeName = incident.location?.placeName ?? null;

  return (
    <li>
      <Link
        href={`/track?ref=${incident.reference}`}
        className="block rounded-card focus-visible:ring-[2px] focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app focus-visible:outline-none"
      >
        <Card className="transition-colors hover:border-strong">
          <CardContent className="flex flex-col gap-2 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="ref-code text-xs text-primary">{incident.reference}</span>
              <StatusBadge status={incident.status} size="sm" />
              <UrgencyBadge urgency={incident.urgency} size="sm" />
            </div>

            <p className="clamp-2 max-w-[72ch] text-sm text-primary">{incident.summary}</p>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-secondary">
              <span className="inline-flex items-center gap-1.5">
                <CategoryIcon className="size-3.5" aria-hidden="true" />
                {category.label}
              </span>
              {placeName ? (
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <MapPin className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">{placeName}</span>
                </span>
              ) : (
                <span className="text-muted">No location on this report</span>
              )}
              <RelativeTime iso={incident.createdAt} />
            </div>
          </CardContent>
        </Card>
      </Link>
    </li>
  );
}
