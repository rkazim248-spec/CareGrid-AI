'use client';

import * as React from 'react';

import {
  Badge,
  Button,
  Card,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui';
import type { Incident } from '@/types';

/**
 * The `/incidents` filter bar (docs/04 §13.8).
 *
 * Separate from the dashboard's `IncidentFilterBar` because this route filters
 * a DIFFERENT question: the dashboard asks "what needs attention now", this
 * asks "what happened, and when". So the pair here is status (including the
 * terminal statuses the live queue never shows) plus a from/to date range, and
 * there is no urgency or SLA filter — a month-old incident has no response
 * target running.
 *
 * The date range is two visible `Input type="date"` fields rather than a
 * `Popover`: on this route the range IS the primary control, and hiding a
 * primary control behind a disclosure is how a history view becomes useless.
 */

export type HistoryQuery = {
  q: string;
  status: string;
  category: string;
  from: string;
  to: string;
};

export const EMPTY_HISTORY_QUERY: HistoryQuery = {
  q: '',
  status: 'all',
  category: 'all',
  from: '',
  to: '',
};

export function countActiveHistoryFilters(query: HistoryQuery): number {
  return [query.q, query.status, query.category, query.from, query.to].filter(Boolean).length;
}

export function matchesHistoryQuery(incident: Incident, query: HistoryQuery): boolean {
  if (query.status !== 'all' && incident.status !== query.status) return false;
  if (query.category !== 'all' && incident.category !== query.category) return false;

  const createdDay = incident.createdAt.slice(0, 10);
  if (query.from && createdDay < query.from) return false;
  if (query.to && createdDay > query.to) return false;

  const needle = query.q.trim().toLowerCase();
  if (!needle) return true;
  return `${incident.reference} ${incident.summary} ${incident.originalText}`
    .toLowerCase()
    .includes(needle);
}

const STATUS_OPTIONS = [
  { value: 'new', label: 'New' },
  { value: 'triaged', label: 'Triaged' },
  { value: 'verified', label: 'Verified' },
  { value: 'assigned', label: 'Assigned' },
  { value: 'en_route', label: 'En route' },
  { value: 'on_scene', label: 'On scene' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'false_alarm', label: 'False alarm' },
  { value: 'merged', label: 'Merged' },
] as const;

const CATEGORY_OPTIONS = [
  { value: 'medical', label: 'Medical' },
  { value: 'fire', label: 'Fire' },
  { value: 'traffic_accident', label: 'Road accident' },
  { value: 'flood', label: 'Flooding' },
  { value: 'heatwave', label: 'Heatwave' },
  { value: 'severe_storm', label: 'Severe storm' },
  { value: 'missing_person', label: 'Missing person' },
  { value: 'violence_crime', label: 'Violence or crime' },
  { value: 'infrastructure', label: 'Infrastructure' },
  { value: 'community_aid', label: 'Community aid' },
  { value: 'other', label: 'Other' },
] as const;

export function HistoryFilters({
  query,
  onQueryChange,
  resultCount,
  onReset,
}: {
  query: HistoryQuery;
  onQueryChange: (next: HistoryQuery) => void;
  resultCount: number;
  onReset: () => void;
}) {
  const id = React.useId();
  const active = countActiveHistoryFilters(query);

  const set = <K extends keyof HistoryQuery>(key: K, value: HistoryQuery[K]) =>
    onQueryChange({ ...query, [key]: value });

  return (
    <Card className="p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
        <Input
          id={`${id}-q`}
          type="search"
          label="Search"
          value={query.q}
          placeholder="Reference or words in the report"
          onChange={(event) => set('q', event.target.value)}
          containerClassName="w-full lg:w-[300px]"
        />

        <div className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Input
            id={`${id}-from`}
            type="date"
            label="From"
            value={query.from}
            onChange={(event) => set('from', event.target.value)}
          />
          <Input
            id={`${id}-to`}
            type="date"
            label="To"
            value={query.to}
            onChange={(event) => set('to', event.target.value)}
          />
          <ChoiceField
            selectId={`${id}-status`}
            label="Status"
            value={query.status}
            onValueChange={(value) => set('status', value)}
            options={STATUS_OPTIONS}
          />
          <ChoiceField
            selectId={`${id}-category`}
            label="Category"
            value={query.category}
            onValueChange={(value) => set('category', value)}
            options={CATEGORY_OPTIONS}
          />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-subtle pt-3">
        <Badge variant="muted" size="sm" className="tabular" aria-live="polite">
          {active} {active === 1 ? 'filter' : 'filters'} · {resultCount} rows
        </Badge>
        {active > 0 ? (
          <Button variant="ghost" size="sm" onClick={onReset} className="min-h-11">
            Clear all
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

function ChoiceField({
  selectId,
  label,
  value,
  onValueChange,
  options,
}: {
  selectId: string;
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
}) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={selectId} className="text-sm font-medium text-secondary">
        {label}
      </label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger id={selectId}>
          <SelectValue placeholder="Any" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Any</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
