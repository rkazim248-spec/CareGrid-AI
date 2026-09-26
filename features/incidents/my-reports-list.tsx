'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ClipboardList } from 'lucide-react';

import { Alert, AlertDescription, AlertIcon, AlertTitle } from '@/components/ui';
import { DemoDataBadge, EMPTY_COPY, EmptyState } from '@/components/feedback';
import { MOCK_INCIDENTS } from '@/lib/mock-data';
import { MyReportCard } from '@/features/incidents/my-report-card';
import { MyReportsFilters } from '@/features/incidents/my-reports-filters';
import type { Incident, IncidentStatus } from '@/types';

/**
 * /incidents for a citizen: "My reports" — docs/04 §13.8, §12.1.
 *
 * A card list, never a table on mobile. The dispatcher archive view (the other
 * half of §13.8) is a different component and is out of scope here.
 *
 * OWNERSHIP NOTE. `Incident` in `types/domain.ts` carries no reporter field by
 * design (data minimisation, docs/04 §1.2 P9), and the Phase 1 session is a
 * mock. So this list renders the demonstration dataset and says so in visible
 * text rather than implying it has been scoped to one account. From Phase 3 the
 * scoping is `GET /api/incidents` with server-side role scoping
 * (docs/08 §3.2) and this component changes no props.
 */
const SAMPLE = MOCK_INCIDENTS.filter((incident) => !incident.deletedAt);

function matches(incident: Incident, needle: string, status: IncidentStatus | null): boolean {
  if (status && incident.status !== status) return false;
  if (!needle) return true;
  const haystack = [
    incident.reference,
    incident.summary,
    incident.location?.placeName ?? '',
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle.toLowerCase());
}

export function MyReportsList() {
  const router = useRouter();
  const [query, setQuery] = React.useState('');
  const [status, setStatus] = React.useState<IncidentStatus | null>(null);

  const visible = React.useMemo(
    () => SAMPLE.filter((incident) => matches(incident, query.trim(), status)),
    [query, status],
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <DemoDataBadge />
        <Alert tone="neutral">
          <AlertIcon tone="neutral" />
          <div className="flex min-w-0 flex-col gap-1">
            <AlertTitle>Sample data</AlertTitle>
            <AlertDescription>
              These are the demonstration records, not your reports. A real build returns only
              reports you filed, scoped by the server.
            </AlertDescription>
          </div>
        </Alert>
      </div>

      <MyReportsFilters
        query={query}
        onQueryChange={setQuery}
        status={status}
        onStatusChange={setStatus}
      />

      {visible.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title={EMPTY_COPY.reports.title}
          description={EMPTY_COPY.reports.description}
          action={{
            label: EMPTY_COPY.reports.actionLabel,
            onClick: () => {
              router.push('/report');
            },
          }}
          footnote="Clearing the search or the status filter brings the sample records back."
        />
      ) : (
        <>
          <p className="text-xs text-secondary tabular">
            Showing {visible.length} of {SAMPLE.length} sample reports.
          </p>
          <ul className="flex flex-col gap-3">
            {visible.map((incident) => (
              <MyReportCard key={incident.incidentId} incident={incident} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
