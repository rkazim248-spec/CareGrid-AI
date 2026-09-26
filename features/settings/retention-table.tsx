'use client';

import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
import { RETENTION_ROWS } from '@/features/settings/settings-copy';

/**
 * The retention table — docs/04 §13.16 Retention copy, docs/07 §11.8, NFR-028.
 *
 * A REAL `<table>`, not a grid of divs: three columns of prose need to be
 * scannable in a fixed relationship, and a screen reader cannot follow the same
 * relationship through styled divs. The caption is `sr-only` but present, and
 * every column header carries `scope="col"` (docs/04 §5.16).
 *
 * A stacked layout is avoided on purpose — this table is a reference a person
 * reads deliberately, not a phone list, and it fits in a `max-w-[720px]` column
 * at 360 px with a horizontal scroll affordance from the `Table` container.
 */
export function RetentionTable() {
  return (
    <Table>
      <TableCaption className="sr-only">
        What CareGrid AI stores, who can see it, and how long it is kept.
      </TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">What is stored</TableHead>
          <TableHead scope="col">Who can see it</TableHead>
          <TableHead scope="col">How long it is kept</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {RETENTION_ROWS.map((row) => (
          <TableRow key={row.item}>
            <TableHead scope="row" className="text-sm font-semibold text-primary">
              {row.item}
            </TableHead>
            <TableCell>{row.visibleTo}</TableCell>
            <TableCell>{row.retention}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
