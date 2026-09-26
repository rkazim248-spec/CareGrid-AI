'use client';

import * as React from 'react';
import Link from 'next/link';
import { Trash2 } from 'lucide-react';

import {
  Badge,
  Card,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
import { ConfidenceBadge, LocationBadge, StatusBadge, UrgencyBadge } from '@/components/domain';
import { CATEGORY_META } from '@/config';
import { formatAge, formatDate } from '@/lib/format';
import type { Incident } from '@/types';
import { SourceBadge } from '@/features/incidents/source-badge';

/**
 * The `/incidents` result set — a real `<table>` at `md` and above, a card list
 * below (docs/04 §5.16 responsive rule, §13.8).
 *
 * A SOFT-DELETED record is rendered, not hidden. It gets the muted treatment
 * `TableRow` already provides for a non-actionable row, a `Deleted` text label
 * beside the reference, and its reason in an inset block underneath. A deleted
 * incident that silently disappeared would read as data loss; one that arrives
 * greyed out with "Duplicate of CG-IN2001, entered in error" reads as a record
 * (docs/04 §13.8 note, FR-123).
 *
 * The reason block spans the full row width, so the record's header cells and
 * its reason stay in one row rather than splitting across a page break.
 */

const COLUMN_COUNT = 8;
const HISTORY_LIST = 'Incident history';

export function HistoryTable({ rows }: { rows: readonly Incident[] }) {
  return (
    <Card>
      <Table>
        <TableCaption className="sr-only">
          Incident history, {rows.length} rows on this page. The reference in each row is a link to
          that incident.
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Reference</TableHead>
            <TableHead scope="col">Category</TableHead>
            <TableHead scope="col">Urgency</TableHead>
            <TableHead scope="col">Status</TableHead>
            <TableHead scope="col">Location</TableHead>
            <TableHead scope="col">Source</TableHead>
            <TableHead scope="col">AI confidence</TableHead>
            <TableHead scope="col">Reported</TableHead>
            <TableHead scope="col">Assignee</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((incident) => (
            <HistoryRow key={incident.incidentId} incident={incident} />
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function HistoryRow({ incident }: { incident: Incident }) {
  const deleted = incident.deletedAt !== null;

  return (
    <TableRow className={deleted ? 'align-top' : undefined} data-state={deleted ? 'pending' : undefined}>
      <TableHead
        scope="row"
        className="min-w-[7ch] px-4 py-3 text-sm font-medium tracking-[0.02em] whitespace-nowrap text-primary normal-case"
      >
        <Link
          href={`/incidents/${incident.incidentId}`}
          className="ref-code text-primary transition-colors hover:text-accent"
        >
          {incident.reference}
        </Link>
        {deleted ? (
          <Badge variant="muted" size="sm" className="ml-2 align-middle">
            <Trash2 className="size-3" aria-hidden="true" />
            Deleted
          </Badge>
        ) : null}
      </TableHead>

      <TableCell className="whitespace-nowrap">{CATEGORY_META[incident.category].label}</TableCell>
      <TableCell>
        <UrgencyBadge urgency={incident.urgency} size="sm" />
      </TableCell>
      <TableCell>
        <StatusBadge status={incident.status} size="sm" />
      </TableCell>
      {/* FR-034: a missing location is stated in words in every dispatcher view.
          An archive row that silently omits location is how a dispatcher ends up
          believing a report was located when it never was. */}
      <TableCell>
        <LocationBadge
          accuracyGrade={incident.location?.accuracyGrade ?? null}
          accuracyM={incident.location?.accuracyM}
          compact
        />
        {incident.location?.placeName ? (
          <span className="clamp-1 mt-0.5 block text-2xs text-muted">
            {incident.location.placeName}
          </span>
        ) : null}
      </TableCell>
      <TableCell>
        <SourceBadge source={incident.verification} />
      </TableCell>
      <TableCell>
        <ConfidenceBadge
          confidence={incident.aiConfidence}
          needsReview={incident.aiNeedsReview}
          size="sm"
        />
      </TableCell>
      <TableCell className="whitespace-nowrap tabular">
        {formatDate(incident.createdAt)} · {formatAge(incident.ageMin)} ago
      </TableCell>
      <TableCell className="whitespace-nowrap">{incident.assignee?.displayName ?? '—'}</TableCell>

      {deleted ? (
        <TableCell colSpan={COLUMN_COUNT}>
          <DeleteReason incident={incident} />
        </TableCell>
      ) : null}
    </TableRow>
  );
}

/** The delete reason, in an inset well so it reads as an annotation, not a column. */
export function DeleteReason({ incident }: { incident: Incident }) {
  return (
    <div className="mt-2 rounded-sm border border-subtle bg-inset p-2">
      <p className="uppercase-label mb-1 text-muted">Reason for deletion</p>
      <p className="text-xs text-secondary">{incident.deleteReason ?? 'No reason recorded.'}</p>
      {incident.deletedAt ? (
        <p className="mt-1 text-2xs text-muted tabular">Deleted {formatDate(incident.deletedAt)}</p>
      ) : null}
    </div>
  );
}

export function HistoryCards({ rows }: { rows: readonly Incident[] }) {
  return (
    <ul className="flex flex-col gap-3" aria-label={HISTORY_LIST}>
      {rows.map((incident) => (
        <li key={incident.incidentId}>
          <Card className={incident.deletedAt ? 'p-3 opacity-70' : 'p-3'}>
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={`/incidents/${incident.incidentId}`}
                  className="ref-code text-sm text-primary hover:text-accent"
                >
                  {incident.reference}
                </Link>
                <UrgencyBadge urgency={incident.urgency} size="sm" />
                <StatusBadge status={incident.status} size="sm" />
                {incident.deletedAt ? (
                  <Badge variant="muted" size="sm">
                    <Trash2 className="size-3" aria-hidden="true" />
                    Deleted
                  </Badge>
                ) : null}
              </div>
              <p className="clamp-2 text-sm text-secondary">{incident.summary}</p>
              <p className="text-xs text-muted tabular">
                {CATEGORY_META[incident.category].label} · {formatDate(incident.createdAt)}
              </p>
              {incident.deletedAt ? <DeleteReason incident={incident} /> : null}
            </div>
          </Card>
        </li>
      ))}
    </ul>
  );
}
