'use client';

import * as React from 'react';
import Link from 'next/link';
import { Route, TriangleAlert } from 'lucide-react';

import {
  Badge,
  Card,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
import { PageHeader } from '@/components/layout';
import { EmptyState, EMPTY_COPY } from '@/components/feedback';
import { Timestamp } from '@/components/domain';
import { formatDistance, formatDuration, formatRelative } from '@/lib/format';
import { MOCK_DISPATCHES, MOCK_RESPONDERS } from '@/lib/mock-data';
import type { Dispatch, DispatchStatus } from '@/types';
import { ResponderStatusBadge } from '@/features/responders/responder-status-badge';
import { useResolvedSession } from '@/components/providers/session-provider';
import { ResponderAssignmentList } from '@/features/dispatch/responder-assignment-list';

/**
 * DispatchLedger — `/dispatches` (docs/04 §13.12).
 *
 * Two different surfaces share this route, decided by ROLE and not viewport:
 *
 *   - a responder gets the LIVE assignment list (`ResponderAssignmentList`):
 *     real dispatch rows over L6 with real Accept/Decline actions (Phase 13
 *     brief §3). The scoping happens server-side — the query is keyed to the
 *     session uid — so a responder is never sent anyone else's rows at all;
 *   - a dispatcher (or admin) keeps the demo ledger below. It is MOCK data
 *     until Phase 2 wires the dispatcher queue; its rows, filters and columns
 *     exist to design the table, not to claim live state.
 *
 * The word "dispatch" here means only "assigning a community responder"
 * (docs/04 §15.4). Nothing on this screen implies an ambulance, a police unit, or
 * any public service, and there is no claim of a partnership with one.
 */

const DISPATCH_STATUS_LABEL: Record<DispatchStatus, string> = {
  active: 'Sent, waiting for a reply',
  accepted: 'Accepted',
  withdrawn: 'Withdrawn',
  completed: 'Completed',
  expired: 'Expired',
};

/** A dispatch status is a lifecycle, not an incident status, so it gets its own table. */
const DISPATCH_STATUS_TONE: Record<DispatchStatus, string> = {
  active: 'border-warning bg-warning-muted text-warning-fg-muted',
  accepted: 'border-success bg-success-muted text-success',
  withdrawn: 'border-default bg-neutral-muted text-secondary',
  completed: 'border-accent bg-accent-muted text-accent-fg-muted',
  expired: 'border-danger bg-danger-muted text-danger-fg-muted',
};

const ASSIGNMENTS_LIST = 'Community responder assignments';
const CAPABILITY_MATCH_YES = 'Matches what the incident needs';
const CAPABILITY_MATCH_NO = 'Does not match';

export function DispatchLedger() {
  const { role } = useResolvedSession();
  const isResponder = role === 'responder';

  // Dispatcher-side state, declared above the branch so flipping the preview
  // role never changes this component's hook count between renders.
  const [responderFilter, setResponderFilter] = React.useState('all');
  const [statusFilter, setStatusFilter] = React.useState('all');
  const id = React.useId();

  const rows = MOCK_DISPATCHES.filter((dispatch) => {
    if (responderFilter !== 'all' && dispatch.responder.uid !== responderFilter) return false;
    if (statusFilter !== 'all' && dispatch.status !== statusFilter) return false;
    return true;
  });

  if (isResponder) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="My assignments"
          description="Live dispatches addressed to you. Answer here, or from the alert when one arrives."
        />
        <ResponderAssignmentList />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Dispatches"
        description="Demo data. Every community responder assignment: who was asked, whether they accepted, and how long they took to reply."
      />

      <Card className="p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <label htmlFor={`${id}-responder`} className="text-sm font-medium text-secondary">
              Responder
            </label>
            <Select value={responderFilter} onValueChange={setResponderFilter}>
              <SelectTrigger id={`${id}-responder`}>
                <SelectValue placeholder="Everyone" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Everyone</SelectItem>
                {MOCK_RESPONDERS.map((responder) => (
                  <SelectItem key={responder.uid} value={responder.uid}>
                    {responder.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor={`${id}-status`} className="text-sm font-medium text-secondary">
              Assignment state
            </label>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger id={`${id}-status`}>
                <SelectValue placeholder="Any" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any</SelectItem>
                {(Object.keys(DISPATCH_STATUS_LABEL) as DispatchStatus[]).map((status) => (
                  <SelectItem key={status} value={status}>
                    {DISPATCH_STATUS_LABEL[status]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </Card>

      {rows.length === 0 ? (
        <EmptyState
          icon={Route}
          title={EMPTY_COPY.dispatches.title}
          description={EMPTY_COPY.dispatches.description}
        />
      ) : (
        <>
          <div className="hidden md:block">
            <DispatchTable rows={rows} />
          </div>
          <div className="md:hidden">
            <DispatchCards rows={rows} />
          </div>
        </>
      )}
    </div>
  );
}

function DispatchTable({ rows }: { rows: readonly Dispatch[] }) {
  return (
    <Card>
      <Table>
        <TableCaption className="sr-only">
          Community responder assignments, {rows.length} rows.
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Incident</TableHead>
            <TableHead scope="col">Responder</TableHead>
            <TableHead scope="col">Assignment</TableHead>
            <TableHead scope="col">Distance</TableHead>
            <TableHead scope="col">Response time</TableHead>
            <TableHead scope="col">Capability match</TableHead>
            <TableHead scope="col">Sent</TableHead>
            <TableHead scope="col">Accepted</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((dispatch) => (
            <tr key={dispatch.dispatchId} className="border-b border-subtle">
              <TableHead
                scope="row"
                className="px-4 py-3 text-sm font-medium tracking-[0.02em] whitespace-nowrap text-primary normal-case"
              >
                <Link
                  href={`/incidents/${dispatch.incidentId}`}
                  className="ref-code text-primary hover:text-accent"
                >
                  {dispatch.incidentReference}
                </Link>
              </TableHead>
              <TableCell className="whitespace-nowrap">{dispatch.responder.displayName}</TableCell>
              <TableCell>
                <Badge
                  variant="default"
                  size="sm"
                  className={DISPATCH_STATUS_TONE[dispatch.status]}
                >
                  {DISPATCH_STATUS_LABEL[dispatch.status]}
                </Badge>
              </TableCell>
              <TableCell className="tabular">{formatDistance(dispatch.distanceM)}</TableCell>
              <TableCell className="tabular">{formatDuration(dispatch.responseSec)}</TableCell>
              <TableCell>
                <CapabilityMatch dispatch={dispatch} />
              </TableCell>
              <TableCell>
                <Timestamp iso={dispatch.dispatchedAt} />
              </TableCell>
              <TableCell>
                {dispatch.acceptedAt ? (
                  <Timestamp iso={dispatch.acceptedAt} />
                ) : (
                  <span className="text-xs text-muted">Not accepted</span>
                )}
              </TableCell>
            </tr>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function DispatchCards({ rows }: { rows: readonly Dispatch[] }) {
  return (
    <ul className="flex flex-col gap-3" aria-label={ASSIGNMENTS_LIST}>
      {rows.map((dispatch) => (
        <li key={dispatch.dispatchId}>
          <Card className="flex flex-col gap-3 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href={`/incidents/${dispatch.incidentId}`}
                className="ref-code text-sm text-primary hover:text-accent"
              >
                {dispatch.incidentReference}
              </Link>
              <Badge
                variant="default"
                size="sm"
                className={DISPATCH_STATUS_TONE[dispatch.status]}
              >
                {DISPATCH_STATUS_LABEL[dispatch.status]}
              </Badge>
            </div>

            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-secondary">
              <span>{dispatch.responder.displayName}</span>
              <ResponderStatusBadge status={dispatch.responder.status} />
              <span className="tabular">{formatDistance(dispatch.distanceM)}</span>
              <span className="text-xs text-muted">
                sent {formatRelative(dispatch.dispatchedAt)}
              </span>
            </p>

            <p className="text-xs text-muted tabular">
              response {formatDuration(dispatch.responseSec)}
            </p>

            <CapabilityMatch dispatch={dispatch} />
          </Card>
        </li>
      ))}
    </ul>
  );
}

/**
 * A capability mismatch is a WARNING, never an error, and never hidden. A
 * dispatcher who assigned a traffic volunteer to a fire is looking at real
 * information; a responder who sees "does not match" on someone else's row learns
 * nothing they should not.
 */
function CapabilityMatch({ dispatch }: { dispatch: Dispatch }) {
  if (dispatch.capabilityMatch) {
    return (
      <Badge
        variant="default"
        size="sm"
        className="border-success bg-success-muted text-success"
      >
        {CAPABILITY_MATCH_YES}
      </Badge>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-xs text-warning">
      <TriangleAlert className="size-3.5" aria-hidden="true" />
      {CAPABILITY_MATCH_NO}
    </span>
  );
}
