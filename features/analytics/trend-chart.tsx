'use client';

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { formatCount } from '@/lib/format';
import type { Analytics } from '@/types';

/**
 * TrendChart — incidents created against incidents resolved, per bucket
 * (docs/04 §13.13 "volume trend").
 *
 * Two series, not one, because the interesting question in an incident queue is
 * not "how much came in" but "is more coming in than going out". The dashed
 * second line is a non-colour channel for the same reason: two hues that are
 * adjacent on the ramp must not be the only difference (docs/04 §2.12).
 *
 * The tooltip is `aria-hidden` as a whole — the `ChartCard` table alternative and
 * its `sr-only` sentence carry the data for assistive technology, because a
 * Recharts tooltip is a floating div that cannot be reached by keyboard.
 */

const CREATED_TOKEN = 'var(--cg-accent)';
const RESOLVED_TOKEN = 'var(--cg-success)';

export default function TrendChart({ data }: { data: Analytics['trend'] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ left: 4, right: 8, top: 8, bottom: 4 }}>
        <CartesianGrid stroke="var(--cg-border-subtle)" vertical={false} />
        <XAxis
          dataKey="bucket"
          stroke="var(--cg-text-muted)"
          tick={{ fill: 'var(--cg-text-muted)', fontSize: 11 }}
          tickFormatter={(value: string) => value.slice(5)}
        />
        <YAxis
          allowDecimals={false}
          stroke="var(--cg-text-muted)"
          tick={{ fill: 'var(--cg-text-muted)', fontSize: 12 }}
        />
        <Tooltip
          contentStyle={{
            background: 'var(--cg-bg-elevated)',
            border: '1px solid var(--cg-border-strong)',
            borderRadius: 6,
            color: 'var(--cg-text-primary)',
            fontSize: 12,
          }}
          labelFormatter={(value: unknown) => String(value)}
          formatter={(value: unknown, name: unknown) => [
            formatCount(Number(value)),
            name === 'created' ? 'Created' : 'Resolved',
          ]}
        />
        <Line
          type="monotone"
          dataKey="created"
          stroke={CREATED_TOKEN}
          strokeWidth={2}
          dot={{ r: 2, fill: CREATED_TOKEN }}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="resolved"
          stroke={RESOLVED_TOKEN}
          strokeWidth={2}
          strokeDasharray="5 4"
          dot={{ r: 2, fill: RESOLVED_TOKEN }}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
