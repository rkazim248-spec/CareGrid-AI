'use client';

import * as React from 'react';
import { Link2, MapPin, Users, X } from 'lucide-react';

import { Button, Card, CardContent, CardHeader, CardTitle, Avatar } from '@/components/ui';
import {
  DuplicateChip,
  LocationBadge,
  RequiredResourceChips,
  SafetyFlagChips,
} from '@/components/domain';
import { CATEGORY_META } from '@/config';
import { formatDistance } from '@/lib/format';
import { MOCK_RESPONDERS } from '@/lib/mock-data';
import type { Incident } from '@/types';
import { ResponderStatusBadge } from '@/features/responders/responder-status-badge';

/**
 * The factual half of the incident panel — every field a dispatcher reads before
 * deciding anything. Split from the panel shell so each file stays about one
 * thing (docs/04 §13.9 left column, §5.9 `Card` anatomy).
 *
 * The single most important behaviour here is what is NOT rendered:
 * `peopleAffected === null` shows an em dash and the words "not stated in the
 * report". It never becomes 0 and it never becomes 1 (FR-023, docs/15 §15.1).
 */

export function IncidentSummary({ incident }: { incident: Incident }) {
  return <p className="max-w-[72ch] text-lg leading-snug text-primary">{incident.summary}</p>;
}

export function IncidentSafetyFlags({ incident }: { incident: Incident }) {
  if (incident.safetyFlags.length === 0) return null;
  return <SafetyFlagChips flags={incident.safetyFlags} max={6} />;
}

export function IncidentLocation({ incident }: { incident: Incident }) {
  const loc = incident.location;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="uppercase-label text-muted">Location</span>
        <LocationBadge
          accuracyGrade={loc?.accuracyGrade ?? null}
          accuracyM={loc?.accuracyM ?? null}
          source={loc?.source ?? 'none'}
        />
        {incident.distanceM === null ? (
          <span className="text-xs text-muted">Distance unknown</span>
        ) : (
          <span className="text-xs text-secondary tabular">
            <MapPin className="mr-1 inline size-3.5" aria-hidden="true" />
            {formatDistance(incident.distanceM)} away
          </span>
        )}
      </div>

      {loc ? (
        <>
          <p className="text-sm text-primary">{loc.placeName ?? 'No place name was resolved'}</p>
          <p className="font-mono text-2xs text-muted tabular">
            {loc.lat.toFixed(5)}, {loc.lng.toFixed(5)}
          </p>
        </>
      ) : (
        <div className="rounded-card border border-dashed border-default bg-inset p-3">
          <p className="text-sm text-primary">No location was recorded with this report.</p>
          <p className="text-xs text-secondary">
            A dispatcher needs to contact the reporter for details. Nothing on this screen claims
            where this happened.
          </p>
        </div>
      )}
    </div>
  );
}

export function PeopleAffected({ incident }: { incident: Incident }) {
  const count = incident.peopleAffected;

  return (
    <div className="flex flex-col gap-0.5">
      <span className="uppercase-label text-muted">People affected</span>
      <p className="flex items-baseline gap-2 text-sm">
        <Users className="size-3.5 text-muted" aria-hidden="true" />
        {count === null ? (
          <>
            <span className="text-lg text-primary">—</span>
            <span className="text-secondary">not stated in the report</span>
          </>
        ) : (
          <span className="text-lg tabular text-primary">{count}</span>
        )}
      </p>
      {count === null ? (
        <p className="text-xs text-muted">
          An unknown count is a real value. It is never shown as 0 or 1.
        </p>
      ) : null}
    </div>
  );
}

export function RequiredResources({ incident }: { incident: Incident }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="uppercase-label text-muted">Required resources</span>
      <RequiredResourceChips resources={incident.requiredResources} />
    </div>
  );
}

/**
 * The duplicate suggestion. A suggestion is NEVER presented as a merge: only a
 * dispatcher links reports, and a link is reversible for 24 hours
 * (docs/04 §14.4, FR-041/FR-046).
 */
export function DuplicateSuggestion({
  incident,
  dismissed,
  onDismiss,
  onLink,
}: {
  incident: Incident;
  dismissed: boolean;
  onDismiss: () => void;
  onLink: () => void;
}) {
  if (incident.duplicateStatus === 'none' || dismissed) return null;
  const other = incident.duplicateOf;

  return (
    <Card>
      <CardHeader className="gap-2">
        <CardTitle className="text-base">Duplicates</CardTitle>
        <DuplicateChip
          status={incident.duplicateStatus}
          primaryReference={other?.reference}
          distanceM={142}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className="text-sm text-secondary">
          Possible duplicate of{' '}
          <span className="font-mono text-primary">{other?.reference ?? 'an earlier report'}</span> (
          142 m, 3 min earlier, same category).
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={onLink} className="min-h-11">
            <Link2 aria-hidden="true" />
            Link report
          </Button>
          <Button variant="outline" size="sm" onClick={onDismiss} className="min-h-11">
            <X aria-hidden="true" />
            Dismiss
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The assignee block. `staleLocation` is a property of the RESPONDER, not the
 * incident, so it is read from the responder record and never inferred from the
 * incident's age (US-022 AC2).
 */
export function IncidentAssignee({ incident }: { incident: Incident }) {
  const assignee = incident.assignee;

  if (!assignee) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Assignment</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-secondary">
            No responder is assigned. Nobody has been sent to this incident.
          </p>
        </CardContent>
      </Card>
    );
  }

  const record = MOCK_RESPONDERS.find((r) => r.uid === assignee.uid);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Assignment</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Avatar name={assignee.displayName} size="sm" />
          <span className="text-sm font-semibold text-primary">{assignee.displayName}</span>
          <ResponderStatusBadge status={assignee.status} />
        </div>
        <p className="text-xs text-secondary">
          {CATEGORY_META[incident.category].label} · {formatDistance(incident.distanceM)} away
        </p>
        {record?.staleLocation ? (
          <p className="text-xs text-warning">
            This responder’s last location update is more than 15 minutes old. The distance above
            may be misleading.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
