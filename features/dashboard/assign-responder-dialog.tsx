'use client';

import * as React from 'react';
import { MapPinOff, Stethoscope, Users } from 'lucide-react';
import { toast } from 'sonner';

import {
  Alert,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Avatar,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  RadioGroup,
  RadioGroupItem,
} from '@/components/ui';
import { resourceNames } from '@/config';
import { MOCK_DISPATCH_CANDIDATES } from '@/lib/mock-data';
import { formatDistance, formatDuration } from '@/lib/format';
import type { DispatchCandidate } from '@/types';

/**
 * AssignResponderDialog — docs/04 §13.7, §13.9, §14.5.
 *
 * US-022 AC2 is the reason this list looks the way it does: a responder whose
 * last location update is old is BADGED and SORTED LAST, however close and
 * however fast. A near pin that is twenty minutes old is a worse answer than a
 * slightly further fresh one, and a table that ranked on distance alone would
 * say otherwise.
 *
 * Phase 1: the dialog is UI-only. Choosing a responder and pressing Assign shows
 * a toast and closes. No request is made, and nothing in the incident changes.
 * From Phase 3 the same handler calls `POST /api/incidents/:id/dispatch`.
 */

/** Group name comes from a constant, never a literal in JSX (docs/04 §5.2). */
const CANDIDATE_GROUP = 'Responders available for this incident';

export function AssignResponderDialog({
  open,
  onOpenChange,
  incidentReference,
  hasLocation,
  onAssigned,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  incidentReference: string;
  /** When false the list is not distance-ranked and says so (docs/04 §14.5). */
  hasLocation: boolean;
  onAssigned?: (candidate: DispatchCandidate) => void;
}) {
  const [selected, setSelected] = React.useState<string>('');

  const ranked = React.useMemo(() => rankCandidates(MOCK_DISPATCH_CANDIDATES), []);

  const handleAssign = () => {
    const candidate = ranked.find((c) => c.responder.uid === selected);
    if (!candidate) return;
    toast.success(`Assigned to ${candidate.responder.displayName}.`, {
      description: `Demo build — nothing was sent. ${formatDistance(candidate.distanceM)} away, about ${formatDuration(candidate.etaSec)}.`,
    });
    onAssigned?.(candidate);
    setSelected('');
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Assign a responder</DialogTitle>
          <DialogDescription>
            {incidentReference} is a community incident. The list is ordered by suitability first
            and distance second, and a responder with an old location is always last.
          </DialogDescription>
        </DialogHeader>

        {hasLocation ? null : (
          <Alert tone="warning">
            <AlertIcon tone="warning" />
            <div>
              <AlertTitle>This incident has no location</AlertTitle>
              <AlertDescription>
                Responders cannot be ranked by distance. This list is ordered by the most recent
                location update.
              </AlertDescription>
            </div>
          </Alert>
        )}

        <RadioGroup
          value={selected}
          onValueChange={setSelected}
          aria-label={CANDIDATE_GROUP}
          className="sm:grid-cols-1"
        >
          {ranked.map((candidate) => (
            <CandidateRow
              key={candidate.responder.uid}
              candidate={candidate}
              checked={selected === candidate.responder.uid}
            />
          ))}
        </RadioGroup>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleAssign}
            disabled={selected === ''}
            {...(selected === '' ? { 'aria-describedby': 'assign-reason' } : {})}
          >
            Assign
          </Button>
        </DialogFooter>
        {selected === '' ? (
          <p id="assign-reason" className="-mt-2 text-xs text-warning">
            Choose a responder to enable Assign.
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** US-022 AC2: stale locations last, then nearest, then ETA. `rank` breaks ties. */
export function rankCandidates(candidates: readonly DispatchCandidate[]): DispatchCandidate[] {
  return [...candidates].sort((a, b) => {
    if (a.staleLocation !== b.staleLocation) return a.staleLocation ? 1 : -1;
    if (a.capabilityMatch !== b.capabilityMatch) return a.capabilityMatch ? -1 : 1;
    if (a.distanceM !== b.distanceM) return a.distanceM - b.distanceM;
    return a.rank - b.rank;
  });
}

function CandidateRow({
  candidate,
  checked,
}: {
  candidate: DispatchCandidate;
  checked: boolean;
}) {
  const { responder } = candidate;
  const inputId = `candidate-${responder.uid}`;

  return (
    <div
      className={
        checked
          ? 'flex items-start gap-3 rounded-card border border-selected bg-elevated p-3'
          : 'flex items-start gap-3 rounded-card border border-subtle p-3'
      }
    >
      <RadioGroupItem id={inputId} value={responder.uid} className="mt-2" />
      <label htmlFor={inputId} className="flex min-w-0 flex-1 cursor-pointer flex-col gap-2">
        <span className="flex flex-wrap items-center gap-2">
          <Avatar name={responder.displayName} size="sm" />
          <span className="text-sm font-semibold text-primary">{responder.displayName}</span>
          <span className="tabular text-xs text-muted">#{candidate.rank}</span>
          <span className="tabular text-xs text-secondary">
            {formatDistance(candidate.distanceM)} · about {formatDuration(candidate.etaSec)}
          </span>
        </span>

        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-secondary">
          <span className="inline-flex items-center gap-1">
            <Stethoscope className="size-3.5" aria-hidden="true" />
            {candidate.capabilityMatch
              ? 'Matches the required resources'
              : `Missing: ${resourceNames(candidate.missingResources).join(', ')}`}
          </span>
          <span className="inline-flex items-center gap-1">
            <Users className="size-3.5" aria-hidden="true" />
            {responder.activeIncidentCount === 0
              ? 'No active incidents'
              : `${responder.activeIncidentCount} active incident`}
          </span>
        </span>

        {candidate.staleLocation ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-warning">
            <MapPinOff className="size-3.5" aria-hidden="true" />
            Location over 15 minutes old — listed last because it may be misleading.
          </span>
        ) : null}
      </label>
    </div>
  );
}
