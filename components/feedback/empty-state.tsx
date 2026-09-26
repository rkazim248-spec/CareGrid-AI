import * as React from 'react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';

/**
 * EmptyState — docs/04 §5.22
 *
 * The description explains WHAT WOULD APPEAR HERE AND HOW TO MAKE IT APPEAR.
 * "No data" is a dead end; a description plus one real action is a route out.
 * Exactly one primary action, or none — never two competing ones.
 */
export type EmptyStateProps = {
  icon: LucideIcon;
  title: string;
  description: React.ReactNode;
  action?: { label: string; onClick?: () => void; href?: string };
  /** Small print under the action. */
  footnote?: React.ReactNode;
  className?: string;
};

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  footnote,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-3 rounded-card border border-dashed border-default bg-surface px-6 py-12 text-center',
        className,
      )}
    >
      <Icon className="size-icon-2xl text-muted" aria-hidden="true" />
      <h3 className="text-lg font-semibold text-primary">{title}</h3>
      <p className="max-w-[52ch] text-sm text-secondary">{description}</p>
      {action ? (
        action.href ? (
          <Button asChild variant="secondary" className="mt-1">
            <a href={action.href}>{action.label}</a>
          </Button>
        ) : (
          <Button variant="secondary" onClick={action.onClick} className="mt-1">
            {action.label}
          </Button>
        )
      ) : null}
      {footnote ? <p className="text-xs text-muted">{footnote}</p> : null}
    </div>
  );
}

/**
 * The exact empty copy for each context, in one place so a screen can never
 * drift into "No data". docs/04 §9.2.
 */
export const EMPTY_COPY = {
  queueNoFilters: {
    title: 'No active incidents',
    description:
      'There are no incidents waiting for attention right now. New reports appear here as soon as triage finishes.',
  },
  queueFiltered: {
    title: 'No incidents match these filters',
    description: 'Try widening the urgency or status filter, or clear the search.',
    actionLabel: 'Clear filters',
  },
  history: {
    title: 'No incidents in this period',
    description: 'Change the date range to look further back.',
    actionLabel: 'Change dates',
  },
  notifications: {
    title: 'You have no notifications',
    description: 'Assignment, status, and SLA updates appear here.',
  },
  dispatches: {
    title: 'No assignments yet',
    description:
      'When a dispatcher assigns you an incident it appears here with directions.',
    actionLabel: 'Set yourself available',
  },
  analytics: {
    title: 'No incidents were recorded in this period',
    description: 'Pick a different date range to see activity.',
    actionLabel: 'Last 7 days',
  },
  audit: {
    title: 'No audit entries match these filters',
    description: 'Widen the date range or clear the action filter.',
    actionLabel: 'Clear filters',
  },
  verifications: {
    title: 'No responders are waiting for review',
    description: 'New responder sign-ups appear here for approval.',
  },
  mapArea: {
    title: 'No incidents in this map area',
    description: 'Zoom out, or clear the filters to see the whole city.',
    actionLabel: 'Clear filters',
  },
  responders: {
    title: 'No responders match these filters',
    description: 'Try a different availability or verification filter.',
    actionLabel: 'Clear filters',
  },
  users: {
    title: 'No users match these filters',
    description: 'Try a different role or status filter, or clear the search.',
    actionLabel: 'Clear filters',
  },
  reports: {
    title: 'No reports yet',
    description: 'When you report an incident it appears here with its progress.',
    actionLabel: 'Report an incident',
  },
} as const;
