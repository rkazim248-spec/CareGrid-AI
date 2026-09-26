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

import { CATEGORY_META } from '@/config';
import { formatCount } from '@/lib/format';
import type { Analytics } from '@/types';

/**
 * CategoryChart — a horizontal `BarChart` of incidents by category
 * (docs/04 §13.13).
 *
 * Colours come from the CSS custom properties in `app/styles/globals.css`, NOT
 * from hex literals: the eslint rule bans a hex in any `.tsx`, and a chart that
 * invents its own palette is a chart design review will miss. `var(--cg-…)` is
 * the same token the rest of the UI reads, so the light theme works with no
 * change here.
 *
 * The value sits at the end of each bar in `tabular` figures, because a bar
 * length is not a number a person can act on (docs/04 §3.3).
 */

const BAR_TOKEN = 'var(--cg-urgency-medium)';
const CRITICAL_TOKEN = 'var(--cg-urgency-critical)';

export default function CategoryChart({ data }: { data: Analytics['byCategory'] }) {
  const rows = data
    .filter((row) => row.count > 0)
    .map((row) => ({
      name: CATEGORY_META[row.category].label,
      count: row.count,
      critical: row.critical,
    }));

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 32 }}>
        <CartesianGrid stroke="var(--cg-border-subtle)" horizontal={false} />
        <XAxis
          type="number"
          allowDecimals={false}
          stroke="var(--cg-text-muted)"
          tick={{ fill: 'var(--cg-text-muted)', fontSize: 12 }}
        />
        <YAxis
          type="category"
          dataKey="name"
          width={110}
          stroke="var(--cg-text-muted)"
          tick={{ fill: 'var(--cg-text-secondary)', fontSize: 12 }}
        />
        <Bar dataKey="count" fill={BAR_TOKEN} radius={[0, 4, 4, 0]} isAnimationActive={false}>
          {rows.map((row) => (
            <Cell
              key={row.name}
              fill={row.critical > 0 ? CRITICAL_TOKEN : BAR_TOKEN}
            />
          ))}
          <LabelList
            dataKey="count"
            position="right"
            formatter={(value: unknown) => formatCount(Number(value))}
            style={{ fill: 'var(--cg-text-secondary)', fontSize: 12 }}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
