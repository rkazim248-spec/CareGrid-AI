'use client';

import * as React from 'react';
import { Table2 } from 'lucide-react';

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';

/**
 * ChartCard — the wrapper every chart on `/analytics` renders inside
 * (docs/04 §13.13, §6.4 of [25](./25_ACCESSIBILITY_RESPONSIVENESS.md)).
 *
 * The rule it exists to enforce: **no chart is chart-only.** Every panel
 * provides a real `<table>` alternative behind a "View as table" control, and the
 * chart itself carries an `sr-only` sentence describing what it shows. A reader
 * using a screen reader, a reader on a phone, or a reader who simply cannot read
 * a 2px line all get the same numbers.
 *
 * `srDescription` is a PROPOSITION, not a caption: it must be a complete
 * sentence, because it is what a screen reader reads in place of the graphic.
 */
export type ChartSeries = {
  columns: readonly string[];
  rows: readonly (readonly string[])[];
};

export function ChartCard({
  title,
  description,
  srDescription,
  table,
  heightClass = 'h-[260px]',
  children,
  className,
}: {
  title: string;
  /** Visible description under the heading. */
  description?: string;
  /** One or two full sentences describing the graphic for a screen reader. */
  srDescription: string;
  /** The accessible alternative. Same numbers, no graphic. */
  table: ChartSeries;
  heightClass?: string;
  /** The chart itself, already dynamically imported. */
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const titleId = React.useId();
  const descriptionId = React.useId();

  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <CardTitle id={titleId} className="text-base">
              {title}
            </CardTitle>
            {description ? <CardDescription>{description}</CardDescription> : null}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setOpen(true)}
            className="min-h-11 shrink-0"
            aria-describedby={descriptionId}
          >
            <Table2 aria-hidden="true" />
            View as table
          </Button>
        </div>
      </CardHeader>

      <CardContent>
        <p id={descriptionId} className="sr-only">
          {srDescription}
        </p>
        <div className={heightClass} aria-hidden="true">
          {children}
        </div>
      </CardContent>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" aria-describedby={undefined}>
          <SheetHeader>
            <SheetTitle>{title}</SheetTitle>
            <SheetDescription>
              The same figures as the chart above, as a table.
            </SheetDescription>
          </SheetHeader>
          <SheetBody>
            <DataTableFallback series={table} caption={`${title} — figures`} />
          </SheetBody>
        </SheetContent>
      </Sheet>
    </Card>
  );
}

/**
 * A plain, always-correct table. Deliberately built from the table primitives
 * rather than a charting library's tooltip: a tooltip cannot be reached by
 * keyboard, cannot be copied, and disappears on scroll.
 */
function DataTableFallback({ series, caption }: { series: ChartSeries; caption: string }) {
  return (
    <Table>
      <TableCaption className="sr-only">{caption}</TableCaption>
      <TableHeader>
        <TableRow>
          {series.columns.map((column) => (
            <TableHead key={column} scope="col">
              {column}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {series.rows.map((row) => (
          <TableRow key={row.join('|')}>
            {row.map((cell, index) => (
              <TableCell key={`${cell}-${index}`} className="tabular">
                {cell}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
