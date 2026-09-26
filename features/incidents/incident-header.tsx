'use client';

import * as React from 'react';
import Link from 'next/link';
import { ExternalLink } from 'lucide-react';

import { Button } from '@/components/ui';
import { ConfidenceBadge, SlaMeter, StatusBadge, UrgencyBadge } from '@/components/domain';
import { CATEGORY_META } from '@/config';
import type { Incident } from '@/types';
import { SourceBadge } from '@/features/incidents/source-badge';

/**
 * The incident page header — docs/04 §13.9.
 *
 * This file owns the route's ONLY `<h1>`, and the reference IS the heading: the
 * reference is the anchor a person quotes over the phone, so it is the largest
 * thing on the screen and it is mono (docs/04 §3.3, §5.28).
 *
 * `IncidentBadgeStrip` is the mobile sticky sub-header from the same spec. It
 * deliberately renders NO heading — a sticky bar repeating an `<h1>` would put
 * two of them in the document.
 */
export function IncidentHeader({ incident }: { incident: Incident }) {
  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="ref-code text-lg text-primary">{incident.reference}</h1>
        <span className="text-xs text-secondary">
          {CATEGORY_META[incident.category].label}
        </span>
        <Button variant="ghost" size="sm" asChild className="min-h-11">
          <Link href={`/map?focus=${incident.incidentId}`}>
            <ExternalLink aria-hidden="true" />
            Open in maps
          </Link>
        </Button>
      </div>

      <IncidentBadgeStrip incident={incident} />

      <p className="max-w-[72ch] text-lg leading-snug text-primary">{incident.summary}</p>

      <SlaMeter
        targetMin={incident.slaTargetMin}
        elapsedMin={incident.ageMin}
        state={incident.slaState}
        className="max-w-sm"
      />
    </header>
  );
}

/** Status + urgency + provenance. Never colour alone (docs/04 §2.12). */
export function IncidentBadgeStrip({ incident }: { incident: Incident }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <StatusBadge status={incident.status} />
      <UrgencyBadge urgency={incident.urgency} source={incident.urgencySource} size="lg" />
      <ConfidenceBadge
        confidence={incident.aiConfidence}
        needsReview={incident.aiNeedsReview}
      />
      <SourceBadge source={incident.verification} size="md" />
    </div>
  );
}
