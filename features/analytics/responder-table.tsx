'use client';

import * as React from 'react';
import { Users } from 'lucide-react';

import {
  Avatar,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
import { formatDuration, formatPercent } from '@/lib/format';
import type { Analytics } from '@/types';

/**
 * ResponderTable — the responder performance list (docs/04 §13.13).
 *
 * This is a LEADERBOARD-shaped table, and that is the one thing it must not be.
 * No rank column, no sorting by response time, no "fastest" badge. A named
 * responder with a slow average next to a named responder with a fast average is
 * a performance review of three people, generated from demo data, in a product
 * that routes emergencies to volunteers.
 *
 * So: a plain table, ordered as the server returned it, with the accept rate
 * stated as a rate and a note saying what these numbers are for. The spec
 * requires this panel to render only when the caller's permissions include it;
 * in Phase 1 the session is mock, so it renders for a dispatcher or an admin
 * only.
 */
export function ResponderTable({ responders }: { responders: Analytics['responders'] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="size-4 text-muted" aria-hidden="true" />
          Responder activity
        </CardTitle>
        <CardDescription>
          Assignments sent, how many were accepted, and the average time to accept. These are
          workload figures, not a ranking.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <Table>
          <TableCaption className="sr-only">
            Assignments per community responder for the selected period.
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Responder</TableHead>
              <TableHead scope="col">Assignments</TableHead>
              <TableHead scope="col">Accepted</TableHead>
              <TableHead scope="col">Accept rate</TableHead>
              <TableHead scope="col">Average time to accept</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {responders.map((row) => (
              <TableRow key={row.uid}>
                <TableHead
                  scope="row"
                  className="px-4 py-3 text-sm font-medium whitespace-nowrap text-primary normal-case"
                >
                  <span className="flex items-center gap-2">
                    <Avatar name={row.displayName} size="xs" />
                    {row.displayName}
                  </span>
                </TableHead>
                <TableCell className="tabular">{row.assignments}</TableCell>
                <TableCell className="tabular">{row.accepted}</TableCell>
                <TableCell>
                  <Badge variant="outline" size="sm" className="tabular">
                    {formatPercent(acceptRate(row.accepted, row.assignments), 0)}
                  </Badge>
                </TableCell>
                <TableCell className="tabular">
                  {formatDuration(row.avgResponseSec)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function acceptRate(accepted: number, assignments: number): number {
  if (assignments === 0) return 0;
  return (accepted / assignments) * 100;
}
