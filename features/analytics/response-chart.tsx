'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';

import { formatCount } from '@/lib/format';
import { URGENCY_META } from '@/config';
import type { Analytics } from '@/types';

/**
 * ResponseChart — two panels' worth of response-time data in one card
 * (docs/04 §13.13 "response histogram" and "p50/p90 by urgency").
 *
 * The histogram counts how many incidents fell into each band, which is the shape
 * an operator actually asks about ("how many took over an hour"). The p50/p90
 * group below it is a table rather than a second chart on purpose: two medians
 * per urgency is eight numbers, and eight numbers read as a list faster than
 * they read as a graphic.
 *
 * Colours are the CSS custom properties from `globals.css`; the emergency-blue
 * band is the one that reads as "past the response target", so it is the only
 * one allowed to be the alarm token.
 */

const BAND_TOKENS = [
  'var(--cg-success)',
  'var(--cg-accent)',
  'var(--cg-urgency-medium)',
  'var(--cg-urgency-high)',
  'var(--cg-urgency-critical)',
  'var(--cg-danger)',
] as const;

export default function ResponseChart({
  buckets,
  byUrgency,
}: {
  buckets: Analytics['responseBuckets'];
  byUrgency: Analytics['byUrgency'];
}) {
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="min-h-[160px] flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={buckets} margin={{ left: 4, right: 8, top: 16, bottom: 4 }}>
            <CartesianGrid stroke="var(--cg-border-subtle)" vertical={false} />
            <XAxis
              dataKey="label"
              stroke="var(--cg-text-muted)"
              tick={{ fill: 'var(--cg-text-muted)', fontSize: 11 }}
              interval={0}
            />
            <YAxis
              allowDecimals={false}
              stroke="var(--cg-text-muted)"
              tick={{ fill: 'var(--cg-text-muted)', fontSize: 12 }}
            />
            <Bar dataKey="count" radius={[4, 4, 0, 0]} isAnimationActive={false}>
              {buckets.map((bucket, index) => (
                <Cell
                  key={bucket.label}
                  fill={BAND_TOKENS[index % BAND_TOKENS.length] ?? 'var(--cg-accent)'}
                />
              ))}
              <LabelList
                dataKey="count"
                position="top"
                formatter={(value: unknown) => formatCount(Number(value))}
                style={{ fill: 'var(--cg-text-secondary)', fontSize: 11 }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <table className="w-full border-t border-subtle text-left text-xs">
        <caption className="sr-only">
          Median and 90th-percentile response time for each urgency, in seconds.
        </caption>
        <thead>
          <tr>
            <th scope="col" className="py-1.5 pr-3 font-semibold text-muted">
              Urgency
            </th>
            <th scope="col" className="py-1.5 pr-3 font-semibold text-muted">
              Median
            </th>
            <th scope="col" className="py-1.5 font-semibold text-muted">
              90th percentile
            </th>
          </tr>
        </thead>
        <tbody>
          {byUrgency.map((row) => (
            <tr key={row.urgency} className="border-t border-subtle">
              <th
                scope="row"
                className="py-1.5 pr-3 text-left font-medium text-primary"
              >
                {URGENCY_META[row.urgency].label}
              </th>
              <td className="py-1.5 pr-3 tabular text-secondary">
                {Math.round(row.p50Sec / 60)} min
              </td>
              <td className="py-1.5 tabular text-secondary">
                {Math.round(row.p90Sec / 60)} min
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
