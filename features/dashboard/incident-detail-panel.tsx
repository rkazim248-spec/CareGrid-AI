'use client';

import * as React from 'react';
import { toast } from 'sonner';

import { StatusBadge, UrgencyBadge, SlaMeter } from '@/components/domain';
import type { Incident, IncidentStatus, UserRole } from '@/types';
import { AiTriagePanel } from '@/features/dashboard/ai-triage-panel';
import { AuditHistory } from '@/features/dashboard/audit-history';
import {
  DuplicateSuggestion,
  IncidentAssignee,
  IncidentLocation,
  IncidentSafetyFlags,
  IncidentSummary,
  PeopleAffected,
  RequiredResources,
} from '@/features/dashboard/incident-facts';
import { ReportsAndTimeline } from '@/features/dashboard/reports-and-timeline';
import { StatusActionBar } from '@/features/dashboard/status-action-bar';

/**
 * IncidentDetailPanel — the required incident content, rendered as a PERSISTENT
 * right-hand panel on the dispatcher dashboard (docs/04 §13.7) and as the body
 * of a `Sheet` on narrow viewports. One component, two hosts, identical
 * content: a dispatcher should not have to learn the same panel twice.
 *
 * EVERYTHING HERE IS UI-ONLY IN PHASE 1. There is no request, no persistence,
 * and no real state change. What is real is the SHAPE of the interaction:
 *  - `verified` flips the local `StatusBadge` to Verified, which is what the
 *    optimistic update in FR-076 will look like once a server exists.
 *  - dismissing a duplicate hides it locally, and says so by staying reversible
 *    on reload.
 *  - the false-alarm path collects a REQUIRED reason and then discards it,
 *    because the audit pattern is the part that must not be retrofitted.
 */
export function IncidentDetailPanel({
  incident,
  role,
  onOpenAssign,
  className,
}: {
  incident: Incident;
  role: UserRole;
  onOpenAssign: () => void;
  className?: string;
}) {
  const [verified, setVerified] = React.useState(false);
  const [duplicateDismissed, setDuplicateDismissed] = React.useState(false);

  const status: IncidentStatus = verified ? 'verified' : incident.status;

  const handleVerify = () => setVerified(true);
  const handleLinkReport = () => {
    toast.info('Link report', {
      description:
        'Demo build — nothing was sent. A linked report keeps both descriptions and both reporters.',
    });
  };

  return (
    <div className={className}>
      <div className="flex flex-col gap-5">
        <header className="flex flex-col gap-2">
          <p className="ref-code text-lg text-primary">{incident.reference}</p>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={status} />
            <UrgencyBadge urgency={incident.urgency} source={incident.urgencySource} size="lg" />
          </div>
          {incident.aiNeedsReview ? (
            <p className="text-xs text-warning">
              This report has a low AI confidence score. Read the original report text before you
              act.
            </p>
          ) : null}
          <SlaMeter
            targetMin={incident.slaTargetMin}
            elapsedMin={incident.ageMin}
            state={incident.slaState}
          />
        </header>

        <IncidentSummary incident={incident} />
        <IncidentSafetyFlags incident={incident} />
        <IncidentLocation incident={incident} />
        <PeopleAffected incident={incident} />
        <RequiredResources incident={incident} />

        <DuplicateSuggestion
          incident={incident}
          dismissed={duplicateDismissed}
          onDismiss={() => setDuplicateDismissed(true)}
          onLink={handleLinkReport}
        />

        <IncidentAssignee incident={incident} />

        <ReportsAndTimeline incident={incident} role={role} />
        <AiTriagePanel incident={incident} />
        <AuditHistory incident={incident} />

        <StatusActionBar
          incident={incident}
          onVerify={handleVerify}
          onOpenAssign={onOpenAssign}
          onLinkReport={handleLinkReport}
        />
      </div>
    </div>
  );
}
