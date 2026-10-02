'use client';

import * as React from 'react';
import { Inbox, UserPlus } from 'lucide-react';

import { PageHeader, LiveIndicator } from '@/components/layout';
import { DemoDataBadge } from '@/components/feedback';
import { Alert, AlertDescription, AlertIcon, AlertTitle } from '@/components/ui';
import { EmptyState, EMPTY_COPY } from '@/components/feedback';
import { DEMO_NOW } from '@/lib/format';
import { MOCK_INCIDENTS } from '@/lib/mock-data';
import type { Incident, UserRole } from '@/types';
import {
  EMPTY_FILTERS,
  hasActiveFilters,
  selectIncidents,
} from '@/features/incidents/incident-filters';
import type { IncidentFilters, IncidentSort } from '@/features/incidents/incident-filters';
import { IncidentFilterBar } from '@/features/incidents/incident-filter-bar';
import { AssignResponderDialog } from '@/features/dashboard/assign-responder-dialog';
import { IncidentDetailPanel } from '@/features/dashboard/incident-detail-panel';
import { IncidentQueue, IncidentQueueCards } from '@/features/dashboard/incident-queue';
import { KpiStrip } from '@/features/dashboard/kpi-strip';

/**
 * DispatcherDashboard — docs/04 §12.3, §13.7. The live work surface.
 *
 * Reading order is the spec's reading order and the layout enforces it: KPI
 * strip, then the filter bar, then the queue, then the selected incident. At
 * `xl` the detail panel becomes a persistent 400 px right column; below `xl` the
 * QUEUE stays the primary column and the panel sits underneath it, because the
 * job on this screen is the queue and moving the panel above it would push the
 * work off the first screen.
 *
 * All state is local: filters, sort, and the selected incident. The sort is
 * `sortIncidents` (FR-071) and it is a pure function so the order is testable.
 */
export function DispatcherDashboard({ role }: { role: UserRole }) {
  const [filters, setFilters] = React.useState<IncidentFilters>(EMPTY_FILTERS);
  const [sort, setSort] = React.useState<IncidentSort>('priority');
  const [selectedId, setSelectedId] = React.useState<string>(MOCK_INCIDENTS[0]?.incidentId ?? '');
  const [assignOpen, setAssignOpen] = React.useState(false);

  const rows = React.useMemo(
    () => selectIncidents(MOCK_INCIDENTS, filters, sort),
    [filters, sort],
  );

  const selected: Incident | undefined =
    rows.find((incident) => incident.incidentId === selectedId) ?? rows[0];

  const canAct = Boolean(selected);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Dashboard"
        description="Every active incident in the area, most urgent first. Selecting a row opens its full record on the right."
        meta={
          <span className="flex flex-wrap items-center gap-2">
            <DemoDataBadge />
            <LiveIndicator state="live" asOfIso={DEMO_NOW.toISOString()} />
          </span>
        }
        actions={[
          {
            label: 'Assign responder',
            variant: 'primary',
            icon: UserPlus,
            onClick: () => setAssignOpen(true),
            ...(canAct ? {} : { disabledReason: 'Select an incident first' }),
          },
        ]}
      />

      <KpiStrip />

      <IncidentFilterBar
        filters={filters}
        onFiltersChange={setFilters}
        sort={sort}
        onSortChange={setSort}
        resultCount={rows.length}
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title={hasActiveFilters(filters) ? EMPTY_COPY.queueFiltered.title : EMPTY_COPY.queueNoFilters.title}
          description={
            hasActiveFilters(filters)
              ? EMPTY_COPY.queueFiltered.description
              : EMPTY_COPY.queueNoFilters.description
          }
          {...(hasActiveFilters(filters)
            ? { action: { label: EMPTY_COPY.queueFiltered.actionLabel, onClick: () => setFilters(EMPTY_FILTERS) } }
            : {})}
        />
      ) : (
        <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
          <div className="min-w-0">
            <div className="hidden md:block">
              <IncidentQueue
                incidents={rows}
                selectedId={selected?.incidentId ?? null}
                onSelect={(incident) => setSelectedId(incident.incidentId)}
                sort={sort}
                onSortChange={setSort}
              />
            </div>
            <div className="md:hidden">
              <IncidentQueueCards
                incidents={rows}
                selectedId={selected?.incidentId ?? null}
                onSelect={(incident) => setSelectedId(incident.incidentId)}
              />
            </div>
          </div>

          <aside className="min-w-0">
            {selected ? (
              <div className="flex flex-col gap-3 xl:sticky xl:top-[72px]">
                <h2 className="text-lg font-semibold text-primary">Selected incident</h2>
                <div className="rounded-card border border-subtle bg-surface p-4">
                  <IncidentDetailPanel
                    incident={selected}
                    role={role}
                    onOpenAssign={() => setAssignOpen(true)}
                  />
                </div>
              </div>
            ) : (
              <Alert tone="info">
                <AlertIcon tone="info" />
                <div>
                  <AlertTitle>No incident selected</AlertTitle>
                  <AlertDescription>
                    Choose a row from the queue to read its report, triage estimate, and audit
                    history.
                  </AlertDescription>
                </div>
              </Alert>
            )}
          </aside>
        </div>
      )}

      {selected ? (
        <AssignResponderDialog
          open={assignOpen}
          onOpenChange={setAssignOpen}
          incidentReference={selected.reference}
          hasLocation={selected.location !== null}
        />
      ) : null}
    </div>
  );
}
