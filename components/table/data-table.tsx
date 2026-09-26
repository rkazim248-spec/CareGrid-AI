import * as React from 'react';

import { cn } from '@/lib/cn';
import { Table, TableBody, TableCaption, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/**
 * DataTable — the generic semantic table.
 *
 * It owns the parts that are easy to forget and impossible to notice missing:
 * an `sr-only` `<caption>`, `scope="col"` on every header, and a real `<table>`
 * rather than a grid of divs. Callers write only the rows.
 *
 * NOTE ON SCOPE: the dispatcher incident queue is NOT built from this. It has a
 * fixed FR-072 column set, a `scope="row"` reference cell, exactly one
 * `aria-sort`, and a card-list variant below 768px, all of which need row-level
 * control — so it lives with its feature
 * (`features/dashboard/incident-queue.tsx`, which doc 20 anticipates as a
 * `components/table/queue-table.tsx` at Phase 3 when real data replaces the
 * mock). This file is the ADMIN table: users, audit log, system health.
 */
export function DataTable({
  caption,
  headers,
  children,
  className,
  rowLabel,
}: {
  /** Describes the table for a screen reader. Say what the table IS. */
  caption: string;
  headers: readonly string[];
  children: React.ReactNode;
  className?: string;
  /** A count or filter summary appended to the caption. */
  rowLabel?: string;
}) {
  return (
    <div className={cn('rounded-card border border-default bg-surface', className)}>
      <Table>
        <TableCaption className="sr-only">
          {caption}
          {rowLabel ? ` ${rowLabel}` : ''}
        </TableCaption>
        <TableHeader>
          <TableRow>
            {headers.map((header) => (
              <TableHead key={header} scope="col">
                {header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>{children}</TableBody>
      </Table>
    </div>
  );
}
