'use client';

import * as React from 'react';
import { ArrowUpDown, ListFilter, X } from 'lucide-react';

import {
  Badge,
  Button,
  Card,
  SearchInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SwitchField,
} from '@/components/ui';
import { CATEGORY_LIST, CATEGORY_META, STATUS_META, URGENCY_META } from '@/config';
import { cn } from '@/lib/cn';
import { SLA_STATES } from '@/types/enums';
import type { IncidentCategory, IncidentStatus, SlaState, Urgency } from '@/types';
import {
  DEFAULT_SORT,
  EMPTY_FILTERS,
  SORT_LABELS,
  activeFilterCount,
  hasActiveFilters,
} from '@/features/incidents/incident-filters';
import type { IncidentFilters, IncidentSort } from '@/features/incidents/incident-filters';

/** Local alias so a cast below reads as a filter sentinel, not a magic string. */
type AnyValue<T extends string> = T | 'all';

const SLA_LABEL: Record<SlaState, string> = {
  on_track: 'On track',
  at_risk: 'At risk',
  breached: 'Target passed',
};

const SORT_OPTIONS: readonly IncidentSort[] = ['priority', 'reference', 'age'];
const ACTIVE_FILTERS_LIST = 'Active filters';

/**
 * IncidentFilterBar — docs/04 §5.32, shared by `/dashboard`, `/incidents`, and
 * `/map` (US-024 AC3 requires the dashboard and the map to hold the same
 * filter, so the component and the state shape are shared rather than
 * re-described twice).
 *
 * Two deviations from §5.32, both deliberate and both Phase-1 scoped:
 *  1. The state is local React state, not the URL. The filter SHAPE and the
 *     option lists are identical, so moving it to search params later is a
 *     change of owner, not a change of contract.
 *  2. The mobile bottom-sheet variant is not built. Below `md` the row wraps
 *     instead, which is honest about the fact that nothing is applied on a
 *     second tap.
 *
 * Every filter has a visible label (docs/04 §5.32 accessibility) and the active
 * set is always visible as a removable chip — never colour alone.
 */
export function IncidentFilterBar({
  filters,
  onFiltersChange,
  sort,
  onSortChange,
  resultCount,
  className,
}: {
  filters: IncidentFilters;
  onFiltersChange: (next: IncidentFilters) => void;
  sort: IncidentSort;
  onSortChange: (next: IncidentSort) => void;
  /** Announced in the results chip so a filter change has a readable outcome. */
  resultCount: number;
  className?: string;
}) {
  const id = React.useId();
  const count = activeFilterCount(filters);

  const set = <K extends keyof IncidentFilters>(key: K, value: IncidentFilters[K]) =>
    onFiltersChange({ ...filters, [key]: value });

  return (
    <Card className={cn('p-4', className)}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <SearchInput
            label="Search the queue"
            helperText="Reference, summary, reporter text, or place name."
            value={filters.q}
            onValueChange={(q) => set('q', q)}
            containerClassName="w-full lg:w-[300px]"
          />

          <div className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <FilterSelect
              selectId={`${id}-status`}
              label="Status"
              value={filters.status}
              onValueChange={(v) => set('status', v as AnyValue<IncidentStatus>)}
              options={(Object.keys(STATUS_META) as IncidentStatus[]).map((s) => ({
                value: s,
                label: STATUS_META[s].label,
              }))}
            />
            <FilterSelect
              selectId={`${id}-urgency`}
              label="Urgency"
              value={filters.urgency}
              onValueChange={(v) => set('urgency', v as AnyValue<Urgency>)}
              options={(Object.keys(URGENCY_META) as Urgency[]).map((u) => ({
                value: u,
                label: URGENCY_META[u].label,
              }))}
            />
            <FilterSelect
              selectId={`${id}-category`}
              label="Category"
              value={filters.category}
              onValueChange={(v) => set('category', v as AnyValue<IncidentCategory>)}
              options={CATEGORY_LIST.map((c) => ({
                value: c,
                label: CATEGORY_META[c].label,
              }))}
            />
            <FilterSelect
              selectId={`${id}-sla`}
              label="Response target"
              value={filters.slaState}
              onValueChange={(v) => set('slaState', v as AnyValue<SlaState>)}
              options={SLA_STATES.map((s) => ({ value: s, label: SLA_LABEL[s] }))}
            />
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t border-subtle pt-3 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="w-full rounded-control border border-subtle px-3 sm:w-[210px]">
            <SwitchField
              id={`${id}-unassigned`}
              label="Unassigned only"
              checked={filters.unassigned}
              onCheckedChange={(v) => set('unassigned', v)}
            />
          </div>

          <div aria-live="polite" className="flex flex-wrap items-center gap-2">
            <Badge variant="muted" size="sm">
              <ListFilter className="size-3.5" aria-hidden="true" />
              {count} {count === 1 ? 'filter' : 'filters'}
            </Badge>
            <Badge variant="muted" size="sm" className="tabular">
              {resultCount} shown
            </Badge>
          </div>

          {hasActiveFilters(filters) ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onFiltersChange(EMPTY_FILTERS)}
              className="min-h-11"
            >
              <X aria-hidden="true" />
              Clear filters
            </Button>
          ) : null}
        </div>

        <ActiveChips filters={filters} onChange={onFiltersChange} />

        <div className="flex flex-wrap items-center gap-2 border-t border-subtle pt-3">
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <ArrowUpDown className="size-3.5" aria-hidden="true" />
            Sorted by
          </span>
          {SORT_OPTIONS.map((option) => (
            <Button
              key={option}
              variant={sort === option ? 'secondary' : 'ghost'}
              size="sm"
              // 32 px is a table-only size on desktop; below `sm` the control is
              // padded to a 44 px target (docs/04 §5.1).
              className="min-h-11"
              aria-pressed={sort === option}
              onClick={() => onSortChange(option)}
            >
              {SORT_LABELS[option]}
            </Button>
          ))}
          {sort !== DEFAULT_SORT ? (
            <Button
              variant="link"
              size="sm"
              onClick={() => onSortChange(DEFAULT_SORT)}
              className="min-h-11"
            >
              Clear sort
            </Button>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

/** A labelled single-value filter. `Select` is Radix, never a native control. */
function FilterSelect({
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

/** Each active filter is individually removable; state is never colour alone. */
function ActiveChips({
  filters,
  onChange,
}: {
  filters: IncidentFilters;
  onChange: (next: IncidentFilters) => void;
}) {
  const chips: { key: keyof IncidentFilters; label: string; clear: IncidentFilters }[] = [];

  if (filters.q.trim()) {
    chips.push({ key: 'q', label: `Search: ${filters.q.trim()}`, clear: { ...filters, q: '' } });
  }
  if (filters.status !== 'all') {
    chips.push({
      key: 'status',
      label: `Status: ${STATUS_META[filters.status as IncidentStatus].label}`,
      clear: { ...filters, status: 'all' },
    });
  }
  if (filters.urgency !== 'all') {
    chips.push({
      key: 'urgency',
      label: `Urgency: ${URGENCY_META[filters.urgency as Urgency].label}`,
      clear: { ...filters, urgency: 'all' },
    });
  }
  if (filters.category !== 'all') {
    chips.push({
      key: 'category',
      label: `Category: ${CATEGORY_META[filters.category as IncidentCategory].label}`,
      clear: { ...filters, category: 'all' },
    });
  }
  if (filters.slaState !== 'all') {
    chips.push({
      key: 'slaState',
      label: `Response target: ${SLA_LABEL[filters.slaState as SlaState]}`,
      clear: { ...filters, slaState: 'all' },
    });
  }
  if (filters.unassigned) {
    chips.push({
      key: 'unassigned',
      label: 'Unassigned only',
      clear: { ...filters, unassigned: false },
    });
  }

  if (chips.length === 0) return null;

  return (
    <ul className="flex flex-wrap items-center gap-2" aria-label={ACTIVE_FILTERS_LIST}>
      {chips.map((chip) => (
        <li key={String(chip.key)}>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onChange(chip.clear)}
            className="min-h-11 gap-1.5"
          >
            {chip.label}
            <X className="size-3.5" aria-hidden="true" />
            <span className="sr-only">— remove this filter</span>
          </Button>
        </li>
      ))}
    </ul>
  );
}
