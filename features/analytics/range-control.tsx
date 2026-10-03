'use client';

import * as React from 'react';
import { Download } from 'lucide-react';

import {
  Badge,
  Button,
  Card,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui';
import { TIMEZONE_LABEL } from '@/lib/format';
import type { Analytics } from '@/types';

/**
 * RangeControl — `from` / `to` / granularity / export, plus the provenance line
 * (docs/04 §13.13, §5.32).
 *
 * `data.range.source` is displayed and never hidden. A chart drawn from a capped
 * live scan and a chart drawn from complete rollups are different claims, and a
 * reader who cannot tell them apart will read a capped scan as a fact about the
 * whole period. `range.advisory` is rendered in a `warning` tone when present,
 * which is the only place the `warning` token appears on this page.
 */

const GRANULARITY_OPTIONS: readonly Analytics['range']['granularity'][] = ['day', 'week'];
const GRANULARITY_HELPER: Record<Analytics['range']['granularity'], string> = {
  day: 'One point per day',
  week: 'One point per week',
};

const SOURCE_LABEL: Record<Analytics['range']['source'], string> = {
  rollup: 'Daily rollups',
  live: 'A live scan, capped at the most recent records',
};

export function RangeControl({
  range,
  onRangeChange,
  canExport,
}: {
  range: Analytics['range'];
  onRangeChange: (next: Analytics['range']) => void;
  canExport: boolean;
}) {
  const id = React.useId();

  const set = <K extends keyof Analytics['range']>(key: K, value: Analytics['range'][K]) =>
    onRangeChange({ ...range, [key]: value });

  return (
    <Card className="p-4">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <Input
            id={`${id}-from`}
            type="date"
            label="From"
            value={range.from}
            onChange={(event) => set('from', event.target.value)}
            containerClassName="w-full lg:w-[180px]"
          />
          <Input
            id={`${id}-to`}
            type="date"
            label="To"
            value={range.to}
            onChange={(event) => set('to', event.target.value)}
            containerClassName="w-full lg:w-[180px]"
          />

          <div className="flex flex-col gap-2 lg:w-[220px]">
            <label htmlFor={`${id}-granularity`} className="text-sm font-medium text-secondary">
              Granularity
            </label>
            <Select
              value={range.granularity}
              onValueChange={(value) =>
                set('granularity', value as Analytics['range']['granularity'])
              }
            >
              <SelectTrigger id={`${id}-granularity`}>
                <SelectValue placeholder="Per day" />
              </SelectTrigger>
              <SelectContent>
                {GRANULARITY_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {GRANULARITY_HELPER[option]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1 lg:ml-auto">
            <Button
              variant="outline"
              disabled
              aria-describedby={`${id}-export-note`}
              className="w-full min-h-11 lg:w-auto"
            >
              <Download aria-hidden="true" />
              Export CSV
            </Button>
            <p id={`${id}-export-note`} className="max-w-60 text-xs text-muted">
              {canExport
                ? 'CSV export is not connected in this build; no file will be created.'
                : 'CSV export is available to dispatchers and administrators.'}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-subtle pt-3">
          <Badge variant="muted" size="sm">
            Source: {SOURCE_LABEL[range.source]}
          </Badge>
          <Badge variant="muted" size="sm">
            Times shown in {range.timezone} ({TIMEZONE_LABEL})
          </Badge>
          {range.advisory ? (
            <Badge variant="default" size="sm" className="border-warning bg-warning-muted text-warning-fg-muted">
              Partial data: {range.advisory}
            </Badge>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
