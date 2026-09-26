'use client';

import {
  SearchInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui';
import { STATUS_META } from '@/config';
import type { IncidentStatus } from '@/types';

/**
 * Search and status filter for "My reports" — docs/04 §5.32, §5.33.
 *
 * Phase 1 keeps both in component state rather than the URL. The URL is the
 * contract for the shared dispatcher filter bar (FR-070); this is a narrower,
 * personal list with no shareable-filter requirement, so local state is the
 * honest simpler choice. The two controls map one-to-one onto the documented
 * `q` and `status` filter keys when the API arrives.
 */
const ANY = 'any';

/**
 * The eleven statuses, in lifecycle order.
 *
 * `STATUS_META` is a `Record<IncidentStatus, StatusMeta>` and is written in the
 * order of the docs/04 §6 table, so its keys are the canonical ordering. The
 * runtime `INCIDENT_STATUSES` array in `types/enums.ts` is not reachable from a
 * component because `@/types` re-exports types only.
 */
const STATUS_ORDER = Object.keys(STATUS_META) as IncidentStatus[];

export function MyReportsFilters({
  query,
  onQueryChange,
  status,
  onStatusChange,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  status: IncidentStatus | null;
  onStatusChange: (value: IncidentStatus | null) => void;
}) {
  const statusLabel = status ? STATUS_META[status].label : 'any status';

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <div className="flex-1">
        <SearchInput
          label="Search my reports"
          value={query}
          onValueChange={onQueryChange}
          helperText="Matches the reference, the summary, and the place name."
          placeholder="Reference, summary, or place"
        />
      </div>

      <div className="sm:w-56">
        <span className="mb-2 block text-sm font-medium text-secondary">Status</span>
        <Select
          value={status ?? ANY}
          onValueChange={(value) => onStatusChange(value === ANY ? null : (value as IncidentStatus))}
        >
          <SelectTrigger aria-label={`Status filter, currently ${statusLabel}`}>
            <SelectValue placeholder="Any status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any status</SelectItem>
            {STATUS_ORDER.map((value) => (
              <SelectItem key={value} value={value}>
                {STATUS_META[value].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
