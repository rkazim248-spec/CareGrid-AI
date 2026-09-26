/**
 * Incident filter + sort logic — the pure half of the dispatcher queue,
 * `/incidents` history, and `/map` (docs/04 §5.16, §5.32, FR-070/FR-071).
 *
 * WHY A SEPARATE MODULE: FR-070 says the URL is the filter state and FR-071
 * fixes the sort order. Both are rules with acceptance criteria, so both are
 * plain functions over plain data — testable without a DOM, and identical
 * across the three routes that need them (US-024 AC3: the dashboard and the map
 * must never disagree about what is being shown).
 *
 * No JSX, no React, no colours. Nothing here renders.
 */

import { STATUS_META, URGENCY_META } from '@/config';
import type { IncidentCategory, IncidentStatus, SlaState, Urgency } from '@/types';
import type { Incident } from '@/types';

/** Sentinel for "no filter" in a single-value Select. Never a real enum value. */
export type AnyValue<T extends string> = T | 'all';

/** The shape every incident surface shares. Adding a key here adds it to all three. */
export type IncidentFilters = {
  q: string;
  status: AnyValue<IncidentStatus>;
  urgency: AnyValue<Urgency>;
  category: AnyValue<IncidentCategory>;
  slaState: AnyValue<SlaState>;
  /** `true` shows only incidents with no responder assigned. */
  unassigned: boolean;
};

/** Sort options. `priority` is the FR-071 default and is what "Clear" restores. */
export type IncidentSort = 'priority' | 'reference' | 'age';

export const DEFAULT_SORT: IncidentSort = 'priority';

export const EMPTY_FILTERS: IncidentFilters = {
  q: '',
  status: 'all',
  urgency: 'all',
  category: 'all',
  slaState: 'all',
  unassigned: false,
};

export const SORT_LABELS: Record<IncidentSort, string> = {
  priority: 'priority',
  reference: 'reference',
  age: 'age (newest first)',
};

/* -------------------------------------------------------------------------- */
/* Filtering                                                                   */
/* -------------------------------------------------------------------------- */

function matchesText(incident: Incident, needle: string): boolean {
  const q = needle.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    incident.reference,
    incident.summary,
    incident.originalText,
    incident.location?.placeName ?? '',
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(q);
}

export function matchesFilters(incident: Incident, filters: IncidentFilters): boolean {
  // A soft-deleted record never appears in a live operational view. It is an
  // archive concern and lives on /incidents behind the `includeDeleted` note.
  if (incident.deletedAt) return false;
  if (filters.status !== 'all' && incident.status !== filters.status) return false;
  if (filters.urgency !== 'all' && incident.urgency !== filters.urgency) return false;
  if (filters.category !== 'all' && incident.category !== filters.category) return false;
  if (filters.slaState !== 'all' && incident.slaState !== filters.slaState) return false;
  if (filters.unassigned && incident.assignee !== null) return false;
  return matchesText(incident, filters.q);
}

export function filterIncidents(
  incidents: readonly Incident[],
  filters: IncidentFilters,
): Incident[] {
  return incidents.filter((incident) => matchesFilters(incident, filters));
}

/** How many filters are narrowing the view. Rendered in the "n filters" chip. */
export function activeFilterCount(filters: IncidentFilters): number {
  let n = 0;
  if (filters.q.trim()) n += 1;
  if (filters.status !== 'all') n += 1;
  if (filters.urgency !== 'all') n += 1;
  if (filters.category !== 'all') n += 1;
  if (filters.slaState !== 'all') n += 1;
  if (filters.unassigned) n += 1;
  return n;
}

export function hasActiveFilters(filters: IncidentFilters): boolean {
  return activeFilterCount(filters) > 0;
}

/* -------------------------------------------------------------------------- */
/* Sorting — FR-071                                                            */
/* -------------------------------------------------------------------------- */

/** Terminal statuses sort after every active one. */
function terminalWeight(incident: Incident): number {
  return STATUS_META[incident.status].terminal ? 1 : 0;
}

/** `breached` first, then `at_risk`, then `on_track`. */
const SLA_WEIGHT: Record<SlaState, number> = { breached: 0, at_risk: 1, on_track: 2 };

/**
 * FR-071, verbatim: active statuses first, then urgency ascending (critical
 * first), then an unassigned incident outranks an assigned one of the same
 * urgency, then a breached SLA outranks the rest, then newest first.
 *
 * `sortIncidents` is exported and pure so the order can be asserted in a unit
 * test rather than eyeballed in a screenshot.
 */
export function compareByPriority(a: Incident, b: Incident): number {
  const byStatus = terminalWeight(a) - terminalWeight(b);
  if (byStatus !== 0) return byStatus;

  const byUrgency = URGENCY_META[a.urgency].rank - URGENCY_META[b.urgency].rank;
  if (byUrgency !== 0) return byUrgency;

  const byAssignee = (a.assignee === null ? 0 : 1) - (b.assignee === null ? 0 : 1);
  if (byAssignee !== 0) return byAssignee;

  const bySla = SLA_WEIGHT[a.slaState] - SLA_WEIGHT[b.slaState];
  if (bySla !== 0) return bySla;

  // Newest first: `createdAt` descending.
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}

export function sortIncidents(
  incidents: readonly Incident[],
  sort: IncidentSort = DEFAULT_SORT,
): Incident[] {
  const copy = [...incidents];
  switch (sort) {
    case 'reference':
      copy.sort((a, b) => a.reference.localeCompare(b.reference));
      return copy;
    case 'age':
      copy.sort((a, b) => b.ageMin - a.ageMin);
      return copy;
    case 'priority':
    default:
      copy.sort(compareByPriority);
      return copy;
  }
}

/** Filter then sort — the one call every incident surface makes. */
export function selectIncidents(
  incidents: readonly Incident[],
  filters: IncidentFilters,
  sort: IncidentSort,
): Incident[] {
  return sortIncidents(filterIncidents(incidents, filters), sort);
}
