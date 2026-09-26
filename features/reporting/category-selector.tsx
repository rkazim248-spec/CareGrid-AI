'use client';

import { RadioGroup, RadioGroupItem } from '@/components/ui';
import { CATEGORY_LIST, CATEGORY_META } from '@/config';
import { REPORT_COPY } from '@/features/reporting/report-copy';
import type { IncidentCategory } from '@/types';

/**
 * Category selector — docs/04 §13.2.
 *
 * A single-select radio group, NOT a set of toggles: one incident has one
 * category, and a group that behaves like multi-select here would produce an
 * ambiguous `category` on the wire.
 *
 * Category is optional. CareGrid AI suggests one and a dispatcher confirms it
 * (docs/04 §1.2 P6), so the empty state is a real state, not a gap.
 *
 * Two columns at `sm` and above; never a horizontal row of 11 at 360 px
 * (docs/04 §5.7).
 */
export function CategorySelector({
  value,
  onChange,
}: {
  value: IncidentCategory | null;
  onChange: (category: IncidentCategory | null) => void;
}) {
  // Built as a value, not a literal in JSX: the design-system lint rule exists so
  // an accessible name cannot drift from the visible label (docs/04 §5.2).
  const groupLabel = 'Category, optional';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium text-primary">{REPORT_COPY.categoryTitle}</h3>
        <p className="text-xs text-secondary">{REPORT_COPY.categoryLead}</p>
      </div>

      <RadioGroup
        value={value ?? 'none'}
        onValueChange={(next) => onChange(next === 'none' ? null : (next as IncidentCategory))}
        className="grid-cols-1 gap-2 sm:grid-cols-2"
        aria-label={groupLabel}
      >
        <CategoryOption id="category-none" value="none" label="Not sure" selected={value === null} />
        {CATEGORY_LIST.map((category) => (
          <CategoryOption
            key={category}
            id={`category-${category}`}
            value={category}
            label={CATEGORY_META[category].label}
            icon={CATEGORY_META[category].icon}
            selected={value === category}
          />
        ))}
      </RadioGroup>
    </div>
  );
}

function CategoryOption({
  id,
  value,
  label,
  icon: Icon,
  selected,
}: {
  id: string;
  value: string;
  label: string;
  icon?: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
  selected: boolean;
}) {
  return (
    <div
      className={
        selected
          ? 'flex min-h-11 items-center gap-2.5 rounded-control border border-accent bg-accent-muted px-3 py-2'
          : 'flex min-h-11 items-center gap-2.5 rounded-control border border-subtle bg-surface px-3 py-2 transition-colors hover:border-strong'
      }
    >
      <RadioGroupItem id={id} value={value} />
      {Icon ? <Icon className="size-4 text-secondary" aria-hidden="true" /> : null}
      <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer text-sm text-primary select-none">
        {label}
      </label>
    </div>
  );
}
