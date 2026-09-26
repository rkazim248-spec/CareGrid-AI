'use client';

import * as React from 'react';

import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { useResolvedSession } from '@/components/providers/session-provider';
/**
 * PageHeader — docs/04 §5 (layout primitives)
 *
 * One `<h1>` per route, and exactly ONE declared primary action (principle P4).
 * A second primary button in the same group is a review rejection, not a style
 * choice.
 *
 * `role` narrows what actions render. It is an affordance, not a boundary —
 * the API re-checks everything (docs/22 §6).
 */
export type PageHeaderAction = {
  label: string;
  href?: string;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger-outline';
  icon?: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
  disabledReason?: string;
};

export function PageHeader({
  title,
  description,
  actions,
  meta,
  children,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  /** Rendered on the RIGHT. Pass at most one `variant="primary"`. */
  actions?: readonly PageHeaderAction[];
  /** Small line under the description: filters, counts, provenance. */
  meta?: React.ReactNode;
  /** Rendered under the header, full width — filter bars, tab strips. */
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-2xl leading-tight font-bold text-primary">{title}</h1>
          {description ? (
            <p className="max-w-[72ch] text-sm text-secondary">{description}</p>
          ) : null}
          {meta ? <div className="mt-1">{meta}</div> : null}
        </div>

        {actions && actions.length > 0 ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {actions.map((action) => (
              <HeaderAction key={action.label} action={action} />
            ))}
          </div>
        ) : null}
      </div>

      {children}
    </div>
  );
}

function HeaderAction({ action }: { action: PageHeaderAction }) {
  const Icon = action.icon;
  const button = (
    <Button
      variant={action.variant ?? 'secondary'}
      disabled={Boolean(action.disabledReason)}
      aria-describedby={action.disabledReason ? 'header-action-reason' : undefined}
      {...(action.href ? { asChild: true } : {})}
    >
      {action.href ? (
        <a href={action.href}>
          {Icon ? <Icon aria-hidden="true" /> : null}
          {action.label}
        </a>
      ) : (
        <>
          {Icon ? <Icon aria-hidden="true" /> : null}
          {action.label}
        </>
      )}
    </Button>
  );

  if (!action.disabledReason) return button;

  // Disabled-with-reason (FR-017, docs/04 §10.4): the reason is rendered as
  // visible text, not hidden in a tooltip on a control that cannot be focused.
  return (
    <div className="flex flex-col gap-1">
      {button}
      <p id="header-action-reason" className="max-w-56 text-xs text-warning">
        {action.disabledReason}
      </p>
    </div>
  );
}

/**
 * SectionHeader — a lower-level heading for a region inside a page. Uses `h2`
 * by default so the document outline stays valid.
 */
export function SectionHeader({
  title,
  description,
  actions,
  as = 'h2',
  className,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  as?: 'h2' | 'h3';
  className?: string;
}) {
  const Heading = as;
  return (
    <div className={cn('flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between', className)}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <Heading className="text-lg leading-tight font-semibold text-primary">{title}</Heading>
        {description ? (
          <p className="max-w-[72ch] text-sm text-secondary">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/**
 * Breadcrumb — docs/04 §5.18
 *
 * Dispatcher/admin only. Citizens and responders use a back button instead,
 * because their hierarchies are one level deep and a breadcrumb would imply
 * navigation that does not exist. Max 3 levels.
 */
export function Breadcrumbs({ trail }: { trail: readonly { label: string; href?: string }[] }) {
  const { role } = useResolvedSession();
  if (role !== 'dispatcher' && role !== 'admin') return null;
  const capped = trail.slice(0, 3);

  return (
    <nav aria-label="Breadcrumb" className="hidden lg:block">
      <ol className="flex items-center gap-1.5 text-xs text-muted">
        {capped.map((crumb, index) => {
          const isLast = index === capped.length - 1;
          return (
            <li key={`${crumb.label}-${index}`} className="flex items-center gap-1.5">
              {index > 0 ? (
                <span aria-hidden="true" className="text-subtle">
                  /
                </span>
              ) : null}
              {crumb.href && !isLast ? (
                <a href={crumb.href} className="transition-colors hover:text-secondary">
                  {crumb.label}
                </a>
              ) : (
                <span aria-current={isLast ? 'page' : undefined} className={isLast ? 'text-secondary' : undefined}>
                  {crumb.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
