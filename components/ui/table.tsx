import * as React from 'react';

import { cn } from '@/lib/cn';

/**
 * Table primitives — docs/04 §5.16
 *
 * A real <table>, always. Column headers carry `scope="col"`, the caption is
 * `sr-only` but present, and the caller supplies `aria-sort` on exactly one
 * header. Below 768px the queue renders a CARD LIST instead of this table
 * (docs/25 §9) — `ScrollTable` is for the cases where a scroll region with a
 * visible affordance is the right answer.
 */
function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table
        data-slot="table"
        className={cn('w-full caption-bottom border-collapse text-sm', className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return (
    <thead
      data-slot="table-header"
      className={cn('[&_tr]:border-b [&_tr]:border-default', className)}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return (
    <tbody
      data-slot="table-body"
      className={cn('[&_tr:last-child]:border-0', className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        'border-b border-subtle transition-colors duration-[--motion-duration-instant]',
        'hover:bg-elevated',
        'data-[state=selected]:border-l-[3px] data-[state=selected]:border-l-selected data-[state=selected]:bg-elevated',
        'data-[state=pending]:opacity-60',
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        'h-9 px-4 text-left align-middle text-2xs font-semibold tracking-[0.06em] text-muted uppercase',
        'whitespace-nowrap [&:has([role=checkbox])]:pr-0',
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return (
    <td
      data-slot="table-cell"
      className={cn('px-4 py-3 align-middle text-sm text-secondary', className)}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: React.ComponentProps<'caption'>) {
  return (
    <caption
      data-slot="table-caption"
      className={cn('mt-4 text-sm text-secondary', className)}
      {...props}
    />
  );
}

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableCaption };
