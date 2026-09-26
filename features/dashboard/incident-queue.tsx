'use client';

import * as React from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronUp, MapPinOff } from 'lucide-react';

import {
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
import { ConfidenceBadge, SlaInline, StatusBadge, UrgencyBadge } from '@/components/domain';
import { CATEGORY_META } from '@/config';
import { formatAge, formatCount, formatDistance } from '@/lib/format';
import type { Incident } from '@/types';
import { SourceBadge } from '@/features/incidents/source-badge';
import type { IncidentSort } from '@/features/incidents/incident-filters';

/**
 * IncidentQueue — the dispatcher queue: the FR-072 column set in its exact
 * documented order (docs/04 §5.16, §12.3 item 1).
 *
 * Built from the table primitives rather than a wrapper so the three things the
 * spec makes non-negotiable are structurally guaranteed:
 *
 *  1. the reference is the ROW HEADER (`<th scope="row">`) and the whole cell is
 *     the link — the reference is the anchor, never a link-coloured fragment of
 *     one (docs/04 §3.3);
 *  2. exactly ONE `aria-sort` is present, on the column the current sort acts
 *     through. The default `priority` order (FR-071) ends in newest-first, so
 *     `aria-sort="descending"` stays on the Age column and the reference column
 *     reads `none` until the dispatcher picks it;
 *  3. the selected row carries `aria-selected` AND the 3 px selected left rule
 *     via `data-state` (docs/04 §4.4).
 *
 * Below `md` the table is replaced by `IncidentQueueCards`: a dispatcher queue
 * on a phone shows a card list, not a horizontally scrolling grid
 * (docs/04 §5.16 responsive rule).
 */

export const QUEUE_COLUMNS = [
  'Reference',
  'Category',
  'Urgency',
  'Source',
  'AI confidence',
  'Status',
  'Distance',
  'Reporters',
  'Age',
  'Assignee',
] as const;

const QUEUE_CARD_LIST = 'Active incidents';

export function IncidentQueue({
  incidents,
  selectedId,
  onSelect,
  sort,
  onSortChange,
}: {
  incidents: readonly Incident[];
  selectedId: string | null;
  onSelect: (incident: Incident) => void;
  sort: IncidentSort;
  onSortChange: (next: IncidentSort) => void;
}) {
  const referenceActive = sort === 'reference';

  return (
    <Card>
      <Table>
        <TableCaption className="sr-only">
          Active incidents, currently sorted by {sort}. The reference in each row is a link to that
          incident.
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead
              scope="col"
              aria-sort={referenceActive ? 'ascending' : 'none'}
              className="normal-case"
            >
              <SortHeader
                label="Reference"
                active={referenceActive}
                note={
                  referenceActive
                    ? 'Sorted by reference, A to Z. Activate to return to the default priority order.'
                    : 'Sort by reference, A to Z.'
                }
                onClick={() => onSortChange(referenceActive ? 'priority' : 'reference')}
              />
            </TableHead>
            <TableHead scope="col">Category</TableHead>
            <TableHead scope="col">Urgency</TableHead>
            <TableHead scope="col">Source</TableHead>
            <TableHead scope="col">AI confidence</TableHead>
            <TableHead scope="col">Status</TableHead>
            <TableHead scope="col">Distance</TableHead>
            <TableHead scope="col" className="text-right">
              Reporters
            </TableHead>
            <TableHead scope="col" aria-sort={referenceActive ? 'none' : 'descending'}>
              <SortHeader
                label="Age"
                active={!referenceActive}
                note={
                  sort === 'age'
                    ? 'Sorted by age, newest first. Activate to return to the default priority order.'
                    : 'Sort by age, newest first.'
                }
                onClick={() => onSortChange(sort === 'age' ? 'priority' : 'age')}
              />
            </TableHead>
            <TableHead scope="col">Assignee</TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {incidents.map((incident) => (
            <QueueRow
              key={incident.incidentId}
              incident={incident}
              selected={selectedId === incident.incidentId}
              onSelect={onSelect}
            />
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function SortHeader({
  label,
  onClick,
  active,
  note,
}: {
  label: string;
  onClick: () => void;
  active: boolean;
  note: string;
}) {
  const Icon = active ? ChevronUp : ChevronDown;
  return (
    <button
      type="button"
      onClick={onClick}
      title={note}
      className="inline-flex items-center gap-1 uppercase hover:text-secondary focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-focus"
    >
      {label}
      <Icon className={active ? 'size-3 text-accent' : 'size-3 text-subtle'} aria-hidden="true" />
      <span className="sr-only">{note}</span>
    </button>
  );
}

function QueueRow({
  incident,
  selected,
  onSelect,
}: {
  incident: Incident;
  selected: boolean;
  onSelect: (incident: Incident) => void;
}) {
  const category = CATEGORY_META[incident.category];
  const CategoryIcon = category.icon;

  return (
    <TableRow
      aria-selected={selected}
      data-state={selected ? 'selected' : undefined}
      onClick={() => onSelect(incident)}
      className="cursor-pointer"
    >
      <TableHead
        scope="row"
        className="min-w-[7ch] px-4 py-2 text-sm font-medium tracking-[0.02em] whitespace-nowrap text-primary normal-case"
      >
        <Link
          href={`/incidents/${incident.incidentId}`}
          onClick={(event) => event.stopPropagation()}
          className="ref-code text-primary transition-colors hover:text-accent"
        >
          {incident.reference}
        </Link>
      </TableHead>

      <TableCell className="px-4 py-2">
        <span className="flex items-center gap-1.5 whitespace-nowrap">
          <CategoryIcon className="size-icon-xs text-muted" aria-hidden="true" />
          {category.label}
          {/*
            FR-034: an incident with no location MUST be visibly flagged in every
            dispatcher view, not just on the map. The row's dashed left rule is
            not enough on its own — that is a border, i.e. colour and shape with
            no words, which is exactly what US-040 AC3 forbids. So the state
            also gets a text chip.
          */}
          {incident.location === null ? (
            <span className="inline-flex h-5 items-center gap-1 rounded-pill border border-dashed border-status-new bg-elevated px-1.5 text-2xs font-semibold tracking-[0.06em] text-muted uppercase">
              Location unknown
            </span>
          ) : null}
        </span>
      </TableCell>

      <TableCell className="px-4 py-2">
        <UrgencyBadge urgency={incident.urgency} source={incident.urgencySource} size="sm" />
      </TableCell>

      <TableCell className="px-4 py-2">
        <SourceBadge source={incident.verification} />
      </TableCell>

      <TableCell className="px-4 py-2">
        <ConfidenceBadge
          confidence={incident.aiConfidence}
          needsReview={incident.aiNeedsReview}
          size="sm"
        />
      </TableCell>

      <TableCell className="px-4 py-2">
        <StatusBadge status={incident.status} size="sm" />
      </TableCell>

      <TableCell className="px-4 py-2 tabular">{formatDistance(incident.distanceM)}</TableCell>

      <TableCell className="px-4 py-2 text-right tabular">
        {formatCount(incident.reporterCount)}
      </TableCell>

      <TableCell className="px-4 py-2">
        <span className="flex flex-col gap-0.5">
          <span className="tabular">{formatAge(incident.ageMin)}</span>
          <SlaInline targetMin={incident.slaTargetMin} elapsedMin={incident.ageMin} />
        </span>
      </TableCell>

      <TableCell className="px-4 py-2">
        {incident.assignee ? (
          <span className="whitespace-nowrap">{incident.assignee.displayName}</span>
        ) : (
          <Badge variant="outline" size="sm">
            Unassigned
          </Badge>
        )}
      </TableCell>
    </TableRow>
  );
}

/** Below `md`: one card per incident, same information, no horizontal scroll. */
export function IncidentQueueCards({
  incidents,
  selectedId,
  onSelect,
}: {
  incidents: readonly Incident[];
  selectedId: string | null;
  onSelect: (incident: Incident) => void;
}) {
  return (
    <ul className="flex flex-col gap-3" aria-label={QUEUE_CARD_LIST}>
      {incidents.map((incident) => {
        const category = CATEGORY_META[incident.category];
        const CategoryIcon = category.icon;
        const selected = selectedId === incident.incidentId;

        return (
          <li key={incident.incidentId}>
            <Card className={selected ? 'border-selected bg-elevated p-3' : 'p-3'}>
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
                </div>

                <p className="clamp-2 text-sm text-secondary">{incident.summary}</p>

                <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                  <span className="flex items-center gap-1">
                    <CategoryIcon className="size-3.5" aria-hidden="true" />
                    {category.label}
                  </span>
                  <span className="tabular">{formatAge(incident.ageMin)}</span>
                  <span className="tabular">{formatCount(incident.reporterCount)} reporters</span>
                  <SlaInline targetMin={incident.slaTargetMin} elapsedMin={incident.ageMin} />
                </p>

                {/* FR-034: same rule on the card list — the missing location is
                    stated in words, not implied by a border. */}
                {incident.location === null ? (
                  <p className="flex items-center gap-1.5 text-xs text-muted">
                    <MapPinOff className="size-3.5" aria-hidden="true" />
                    Location unknown. A dispatcher will need to contact the reporter.
                  </p>
                ) : (
                  <p className="clamp-1 text-xs text-muted">{incident.location.placeName}</p>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  <ConfidenceBadge
                    confidence={incident.aiConfidence}
                    needsReview={incident.aiNeedsReview}
                    size="sm"
                  />
                  <SourceBadge source={incident.verification} />
                </div>

                <Button
                  variant={selected ? 'secondary' : 'outline'}
                  size="sm"
                  onClick={() => onSelect(incident)}
                  aria-pressed={selected}
                  className="w-full min-h-11"
                >
                  {selected ? 'Showing details' : 'Show details'}
                </Button>
              </div>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
