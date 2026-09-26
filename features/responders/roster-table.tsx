'use client';

import * as React from 'react';
import { MapPinOff } from 'lucide-react';

import {
  Avatar,
  Badge,
  Button,
  Card,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
import { RelativeTime } from '@/components/domain';
import { resourceName } from '@/config';
import { DEMO_CENTER, formatDistance, formatRelative, haversineM } from '@/lib/format';
import type { Responder } from '@/types';
import {
  ResponderStatusBadge,
  ResponderVerificationBadge,
} from '@/features/responders/responder-status-badge';

/**
 * The roster table and its mobile card list (docs/04 §5.16 responsive rule).
 *
 * The "last fix" column is the interesting one: it is not a timestamp for its own
 * sake, it is the freshness signal that decides whether a responder's distance is
 * worth anything. A responder whose fix is old is badged in a second channel
 * (`MapPinOff` + text), never left to a colour (docs/04 §11.3, US-022 AC2).
 */

const CAPACITY_LABEL = 'How many incidents this responder can hold at once';
const ROSTER_LIST = 'Community responders';

export function RosterTable({
  rows,
  onOpen,
}: {
  rows: readonly Responder[];
  onOpen: (uid: string) => void;
}) {
  return (
    <Card>
      <Table>
        <TableCaption className="sr-only">
          Community responders, {rows.length} rows. Open a row to see the full record.
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Name</TableHead>
            <TableHead scope="col">Availability</TableHead>
            <TableHead scope="col">Verification</TableHead>
            <TableHead scope="col">Capabilities</TableHead>
            <TableHead scope="col" title={CAPACITY_LABEL}>
              Load
            </TableHead>
            <TableHead scope="col">Last fix</TableHead>
            <TableHead scope="col">Distance</TableHead>
            <TableHead scope="col">Record</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((responder) => (
            <RosterRow key={responder.uid} responder={responder} onOpen={onOpen} />
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function RosterRow({
  responder,
  onOpen,
}: {
  responder: Responder;
  onOpen: (uid: string) => void;
}) {
  return (
    <TableRow>
      <TableHead
        scope="row"
        className="px-4 py-3 text-sm font-medium whitespace-nowrap text-primary normal-case"
      >
        <span className="flex items-center gap-2">
          <Avatar name={responder.displayName} size="xs" />
          {responder.displayName}
        </span>
      </TableHead>
      <TableCell>
        <ResponderStatusBadge status={responder.status} />
      </TableCell>
      <TableCell>
        <ResponderVerificationBadge verification={responder.verification} />
      </TableCell>
      <TableCell>
        <CapabilityChips responder={responder} />
      </TableCell>
      <TableCell className="tabular">
        {responder.activeIncidentCount}/{responder.maxConcurrentIncidents}
      </TableCell>
      <TableCell>
        <LastFix responder={responder} />
      </TableCell>
      <TableCell className="tabular">{distanceFor(responder)}</TableCell>
      <TableCell>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onOpen(responder.uid)}
          className="min-h-11"
        >
          Open
        </Button>
      </TableCell>
    </TableRow>
  );
}

export function RosterCards({
  rows,
  onOpen,
}: {
  rows: readonly Responder[];
  onOpen: (uid: string) => void;
}) {
  return (
    <ul className="flex flex-col gap-3" aria-label={ROSTER_LIST}>
      {rows.map((responder) => (
        <li key={responder.uid}>
          <Card className="flex flex-col gap-2 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Avatar name={responder.displayName} size="sm" />
              <span className="text-sm font-semibold text-primary">{responder.displayName}</span>
              <ResponderStatusBadge status={responder.status} />
              <ResponderVerificationBadge verification={responder.verification} />
            </div>

            <CapabilityChips responder={responder} />

            <p className="text-xs text-muted tabular">
              {responder.activeIncidentCount}/{responder.maxConcurrentIncidents} active ·{' '}
              {distanceFor(responder)}
              {responder.lastLocationAt
                ? ` · last fix ${formatRelative(responder.lastLocationAt)}`
                : ''}
            </p>

            {responder.staleLocation ? (
              <p className="flex items-center gap-1 text-xs text-warning">
                <MapPinOff className="size-3.5" aria-hidden="true" />
                Location over 15 minutes old — listed last for assignments.
              </p>
            ) : null}

            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpen(responder.uid)}
              className="w-full min-h-11"
            >
              Open record
            </Button>
          </Card>
        </li>
      ))}
    </ul>
  );
}

function CapabilityChips({ responder }: { responder: Responder }) {
  if (responder.capabilities.length === 0) {
    return <span className="text-xs text-muted">None listed</span>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {responder.capabilities.map((id) => (
        <Badge key={id} variant="outline" size="sm">
          {resourceName(id)}
        </Badge>
      ))}
    </span>
  );
}

function LastFix({ responder }: { responder: Responder }) {
  if (!responder.lastLocationAt) {
    return <span className="text-xs text-muted">Never reported</span>;
  }
  return (
    <span className="flex flex-col gap-0.5">
      <RelativeTime iso={responder.lastLocationAt} />
      {responder.staleLocation ? (
        <span className="flex items-center gap-1 text-2xs text-warning">
          <MapPinOff className="size-3" aria-hidden="true" />
          Over 15 min old
        </span>
      ) : null}
    </span>
  );
}

function distanceFor(responder: Responder): string {
  if (!responder.location) return '—';
  return formatDistance(haversineM(responder.location, DEMO_CENTER));
}
