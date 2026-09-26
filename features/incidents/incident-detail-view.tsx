'use client';


import * as React from 'react';
import Link from 'next/link';
import { ChevronLeft, UserPlus } from 'lucide-react';

import { Button, Card, CardContent } from '@/components/ui';
import { Breadcrumbs, SectionHeader } from '@/components/layout';
import { AssignResponderDialog } from '@/features/dashboard/assign-responder-dialog';
import { IncidentDetailPanel } from '@/features/dashboard/incident-detail-panel';
import { IncidentBadgeStrip, IncidentHeader } from '@/features/incidents/incident-header';
import type { Incident } from '@/types';
import { useResolvedSession } from '@/components/providers/session-provider';

/**
 * IncidentDetailView — `/incidents/[id]` (docs/04 §13.9).
 *
 * Three layouts from one tree, decided by breakpoints and not by JS:
 *
 *   ≥ 1280  two columns. Left: header, full record, reports, timeline. Right: a
 *           sticky action rail.
 *   768–1279 one column, action rail ABOVE the record — a tablet reader needs
 *           the judgement before the evidence.
 *   < 768   one column, badges in a sticky sub-header, and the SINGLE primary
 *           action pinned to a sticky bar above the bottom nav (docs/04 §13.9).
 *
 * The record itself is `IncidentDetailPanel` — the same component the dashboard
 * shows in its right-hand column. A dispatcher should not learn to read an
 * incident twice.
 */
export function IncidentDetailView({ incident }: { incident: Incident }) {
  const [assignOpen, setAssignOpen] = React.useState(false);
  const { role } = useResolvedSession();

  return (
    <div className="flex flex-col gap-6">
      <Breadcrumbs trail={[{ label: 'Operations' }, { label: incident.reference }]} />

      <Button variant="ghost" size="sm" asChild className="-ml-3 min-h-11 self-start">
        <Link href="/incidents">
          <ChevronLeft aria-hidden="true" />
          All incidents
        </Link>
      </Button>

      {/* Mobile sticky sub-header: badges only, never a second <h1>. */}
      <div className="sticky top-[56px] z-10 -mx-4 border-b border-subtle bg-app px-4 py-2 md:hidden">
        <IncidentBadgeStrip incident={incident} />
      </div>

      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="order-2 flex min-w-0 flex-col gap-6 xl:order-1">
          <IncidentHeader incident={incident} />

          <Card>
            <CardContent className="pt-4">
              <SectionHeader
                title="Full record"
                description="Reports, triage estimate, duplicates, and the recent audit trail for this incident."
              />
              <IncidentDetailPanel
                className="mt-4"
                incident={incident}
                role={role ?? 'citizen'}
                onOpenAssign={() => setAssignOpen(true)}
              />
            </CardContent>
          </Card>
        </div>

        <aside className="order-1 flex min-w-0 flex-col gap-4 xl:order-2 xl:sticky xl:top-[72px] xl:self-start">
          <ActionRail incident={incident} onOpenAssign={() => setAssignOpen(true)} />
        </aside>
      </div>

      {/* Mobile: exactly ONE primary action, pinned above the bottom nav. */}
      <div className="sticky bottom-16 z-20 -mx-4 border-t border-subtle bg-surface p-3 xl:hidden">
        <Button
          variant="primary"
          size="xl"
          onClick={() => setAssignOpen(true)}
          className="w-full min-h-14"
        >
          <UserPlus aria-hidden="true" />
          Assign responder
        </Button>
      </div>

      <AssignResponderDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        incidentReference={incident.reference}
        hasLocation={incident.location !== null}
      />
    </div>
  );
}

/**
 * The sticky right column. Deliberately short: the judgement a dispatcher makes
 * here is "who goes", and everything supporting that is one button away.
 */
function ActionRail({
  incident,
  onOpenAssign,
}: {
  incident: Incident;
  onOpenAssign: () => void;
}) {
  const alreadyAssigned = incident.assignee !== null;

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-4">
        <SectionHeader
          title="Action rail"
          description="What you can do to this incident right now."
          as="h2"
        />
        <Button variant="secondary" onClick={onOpenAssign} className="w-full min-h-11">
          <UserPlus aria-hidden="true" />
          {alreadyAssigned ? 'Reassign a responder' : 'Assign a responder'}
        </Button>
        <p className="text-xs text-muted">
          {alreadyAssigned
            ? `${incident.assignee?.displayName} is assigned. Assigning again replaces them, and the change is audited.`
            : 'Nobody has been assigned to this incident yet.'}
        </p>
      </CardContent>
    </Card>
  );
}
