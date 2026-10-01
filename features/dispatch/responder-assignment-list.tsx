'use client';

import * as React from 'react';
import Link from 'next/link';
import { Navigation } from 'lucide-react';

import {
  Alert,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Skeleton,
  Textarea,
} from '@/components/ui';
import { EmptyState, EMPTY_COPY } from '@/components/feedback';
import { REPORT_LIMITS } from '@/config';
import { formatClock, formatDistance, formatRelative } from '@/lib/format';
import type { DispatchStatus } from '@/types';
import { useDispatchResponse } from '@/features/dispatch/use-dispatch-response';
import { useResponderDispatches } from '@/features/dispatch/use-responder-dispatch-alert';
import type { LiveDispatchRow } from '@/features/dispatch/live-dispatch-row';

/**
 * The responder's LIVE assignment list for `/dispatches` (Phase 13 brief §3).
 *
 * This is the real-data counterpart to the dispatcher's mock ledger: dispatch
 * rows come from L6, and Accept/Decline call the real endpoints. Rows awaiting
 * an answer sort above accepted ones; within each group the query's
 * newest-first order is preserved by the stable sort.
 *
 * The rows carry no incident reference — the dispatch document deliberately
 * does not denormalise one — so a row links by incident id, the same id the
 * alert dialog and the dispatcher's notifications use. Nothing is invented to
 * look complete.
 */

// The live query only returns active/accepted rows, but the row type is the
// full DispatchStatus union — the map stays total so a future query change
// degrades to a label, not a crash.
const STATUS_CHIP: Record<DispatchStatus, string> = {
  active: 'border-accent text-accent',
  accepted: 'border-success text-success',
  withdrawn: 'border-default text-secondary',
  completed: 'border-accent text-accent',
  expired: 'border-danger text-danger',
};

const STATUS_TEXT: Record<DispatchStatus, string> = {
  active: 'Waiting for your answer',
  accepted: 'Accepted',
  withdrawn: 'Withdrawn',
  completed: 'Completed',
  expired: 'Expired',
};

export function ResponderAssignmentList() {
  const { items, error, hasReceivedSnapshot } = useResponderDispatches();
  const [declineTarget, setDeclineTarget] = React.useState<LiveDispatchRow | null>(null);
  const closeDecline = React.useCallback(() => setDeclineTarget(null), []);
  const { respond, pending } = useDispatchResponse(closeDecline);

  // Awaited-answer rows first; stable sort keeps newest-first inside each group.
  const sorted = React.useMemo(
    () => [...items].sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1)),
    [items],
  );

  if (error !== null) {
    return (
      <Alert tone="danger" role="alert">
        <AlertIcon tone="danger" />
        <div className="flex min-w-0 flex-col gap-1">
          <AlertTitle>Live updates are unavailable</AlertTitle>
          <AlertDescription>
            Your assignment list could not be loaded
            {error.retryable ? ' and will resume automatically when the connection returns' : ''}.
            Your previous answers are safe.
          </AlertDescription>
        </div>
      </Alert>
    );
  }

  if (!hasReceivedSnapshot) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading your assignments">
        <Skeleton className="h-36 w-full" />
        <Skeleton className="h-36 w-full" />
      </div>
    );
  }

  if (sorted.length === 0) {
    return (
      <EmptyState
        icon={Navigation}
        title={EMPTY_COPY.dispatches.title}
        description={EMPTY_COPY.dispatches.description}
      />
    );
  }

  return (
    <>
      <ul className="flex flex-col gap-3" aria-label="Your assignments">
        {sorted.map((row) => (
          <li key={row.id}>
            <AssignmentRow
              row={row}
              pending={pending}
              onAccept={() => respond('accept', row.id)}
              onDecline={() => setDeclineTarget(row)}
            />
          </li>
        ))}
      </ul>

      <DeclineDialog
        target={declineTarget}
        pending={pending}
        onClose={closeDecline}
        onConfirm={(reason) => {
          if (declineTarget) respond('decline', declineTarget.id, reason || undefined);
        }}
      />
    </>
  );
}

function AssignmentRow({
  row,
  pending,
  onAccept,
  onDecline,
}: {
  row: LiveDispatchRow;
  pending: boolean;
  onAccept: () => void;
  onDecline: () => void;
}) {
  // No ticking clock here — the list re-renders on every snapshot, and an
  // expired row disappears once the server marks it. A stale-by-a-second
  // judgement call belongs to the alert dialog, which does tick.
  const expiresAtMs = row.expiresAt === null ? null : Date.parse(row.expiresAt);
  const windowClosed = expiresAtMs !== null && expiresAtMs <= Date.now();

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_CHIP[row.status]}`}
          >
            {STATUS_TEXT[row.status]}
          </span>
          <span className="text-xs text-muted tabular">
            {row.capabilityMatch ? 'Your capabilities match' : 'Not a full capability match'}
          </span>
        </div>

        <p className="text-sm">
          <Link
            href={`/incidents/${row.incidentId}`}
            className="ref-code font-medium text-accent underline-offset-4 hover:underline"
          >
            Incident {row.incidentId}
          </Link>
        </p>

        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-secondary">
          <span className="tabular">{formatDistance(row.distanceM)} away</span>
          {row.dispatchedAt ? (
            <span className="text-xs text-muted">sent {formatRelative(row.dispatchedAt)}</span>
          ) : null}
          {row.status === 'accepted' && row.acceptedAt ? (
            <span className="text-xs text-muted">accepted {formatRelative(row.acceptedAt)}</span>
          ) : null}
        </p>

        {row.status === 'active' ? (
          <div className="flex flex-col gap-2 border-t border-subtle pt-3">
            {row.expiresAt && !windowClosed ? (
              <p className="text-xs text-muted tabular">
                Response window closes at {formatClock(row.expiresAt)}
              </p>
            ) : null}
            {windowClosed ? (
              <p className="text-xs font-medium text-danger" role="status">
                The response window has closed. You can still decline to clear it.
              </p>
            ) : null}
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                variant="danger-outline"
                size="md"
                className="min-h-11 flex-1"
                onClick={onDecline}
                disabled={pending}
              >
                Decline
              </Button>
              <Button
                variant="danger"
                size="md"
                className="min-h-11 flex-1"
                onClick={onAccept}
                disabled={pending || windowClosed}
              >
                Accept
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function DeclineDialog({
  target,
  pending,
  onClose,
  onConfirm,
}: {
  target: LiveDispatchRow | null;
  pending: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = React.useState('');

  // The dialog target changes between openings; clear the previous reason.
  React.useEffect(() => {
    if (target !== null) setReason('');
  }, [target]);

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Decline this assignment?</DialogTitle>
          <DialogDescription>
            {target ? `Incident ${target.incidentId} goes back to the dispatcher.` : ''} The
            dispatcher is notified in-app. A reason is optional.
          </DialogDescription>
        </DialogHeader>

        <Textarea
          label="Reason (optional)"
          placeholder="e.g. already on another call, not equipped for this incident type"
          rows={3}
          maxChars={REPORT_LIMITS.reasonMaxChars}
          showCount
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          disabled={pending}
        />

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Keep it
          </Button>
          <Button
            variant="danger-outline"
            onClick={() => onConfirm(reason.trim())}
            loading={pending}
          >
            Decline
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
