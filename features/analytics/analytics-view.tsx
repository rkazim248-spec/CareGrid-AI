'use client';


import * as React from 'react';
import dynamic from 'next/dynamic';
import { Info } from 'lucide-react';

import {
  Alert,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui';
import { PageHeader, SectionHeader } from '@/components/layout';
import { CATEGORY_META, URGENCY_META } from '@/config';
import { DEMO_NOW, formatCount, formatDate, formatDuration } from '@/lib/format';
import { MOCK_ANALYTICS } from '@/lib/mock-data';
import type { Analytics } from '@/types';
import { ChartCard } from '@/features/analytics/chart-card';
import type { ChartSeries } from '@/features/analytics/chart-card';
import { KpiGrid } from '@/features/analytics/kpi-grid';
import { RangeControl } from '@/features/analytics/range-control';
import { ResponderTable } from '@/features/analytics/responder-table';
import { RiskSection } from '@/features/analytics/risk-section';
import { useResolvedSession } from '@/components/providers/session-provider';

/**
 * AnalyticsView — `/analytics` (docs/04 §13.13, FR-110…FR-118).
 *
 * Four rules this screen is built to hold:
 *
 *  1. **No chart is chart-only.** Every chart is inside a `ChartCard` that
 *     carries an `sr-only` sentence and a "View as table" alternative with the
 *     same numbers. A reader with a screen reader, on a phone, or simply unable
 *     to read a 2px line gets the same figures.
 *  2. **Provenance is on the page.** `range.source`, the timezone, and any
 *     `range.advisory` are rendered next to the control that changed them, not
 *     buried in a tooltip.
 *  3. **Demo data says so.** A `neutral` Alert states it once, at the top, in the
 *     exact words the spec requires.
 *  4. **No comparative claims.** The risk section reports scores and counts. It
 *     never says one place is riskier than another, because these are fabricated
 *     numbers and a comparison would be a fabricated claim about a real city.
 *
 * Recharts is loaded with `next/dynamic` + `ssr: false` (docs/04 §5.30 pattern):
 * it measures the DOM, so a server render is not merely wasteful but wrong.
 */

const CategoryChart = dynamic(() => import('@/features/analytics/category-chart'), { ssr: false });
const TrendChart = dynamic(() => import('@/features/analytics/trend-chart'), { ssr: false });
const ResponseChart = dynamic(() => import('@/features/analytics/response-chart'), { ssr: false });

const DEMO_NOTICE =
  'Demo data. These figures are fabricated for this UI shell and describe no real city.';

/** Region names come from a constant, never a literal in JSX (docs/04 §5.2). */
const CHARTS_REGION = 'Charts';

export function AnalyticsView() {

  const { role } = useResolvedSession();
  const [range, setRange] = React.useState<Analytics['range']>(MOCK_ANALYTICS.range);

  const analytics = MOCK_ANALYTICS;
  const canExport = role === 'dispatcher' || role === 'admin';
  const showResponders = canExport;


  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Analytics"
        description="Operational volume, category mix, response times, and risk zones for a period you choose."
        meta={
          <span className="text-xs text-secondary">
            Covering {formatDate(range.from)} to {formatDate(range.to)}, in {range.timezone}.
          </span>
        }
      />

      <Alert tone="neutral">
        <AlertIcon tone="neutral" />
        <div>
          <AlertTitle className="flex items-center gap-1.5">
            <Info className="size-3.5" aria-hidden="true" />
            About these numbers
          </AlertTitle>
          <AlertDescription>{DEMO_NOTICE}</AlertDescription>
        </div>
      </Alert>

      <RangeControl range={range} onRangeChange={setRange} canExport={canExport} />

      <KpiGrid totals={analytics.totals} asOfIso={DEMO_NOW.toISOString()} />

      <section aria-label={CHARTS_REGION} className="flex flex-col gap-4">
        <SectionHeader
          title="Distribution and trend"
          description="Each chart has a table alternative with the same figures."
        />
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <ChartCard
            title="Incidents by category"
            description="How many incidents of each kind were recorded in the period."
            srDescription={categorySrText(analytics.byCategory)}
            table={categoryTable(analytics.byCategory)}
          >
            <CategoryChart data={analytics.byCategory} />
          </ChartCard>

          <ChartCard
            title="Created against resolved"
            description="Two series per bucket: incidents created, and incidents resolved."
            srDescription={trendSrText(analytics.trend)}
            table={trendTable(analytics.trend)}
          >
            <TrendChart data={analytics.trend} />
          </ChartCard>

          <ChartCard
            title="Response time distribution"
            description="How many incidents fell into each time band from report to responder."
            srDescription={responseSrText(analytics.responseBuckets, analytics.byUrgency)}
            table={responseTable(analytics.responseBuckets)}
          >
            <ResponseChart
              buckets={analytics.responseBuckets}
              byUrgency={analytics.byUrgency}
            />
          </ChartCard>

          <UrgencyBreakdown byUrgency={analytics.byUrgency} />
        </div>
      </section>

      <RiskSection zones={analytics.riskZones} />

      {showResponders ? <ResponderTable responders={analytics.responders} /> : null}
    </div>
  );
}

/** Priority distribution as a table — eight numbers read faster than a graphic. */
function UrgencyBreakdown({ byUrgency }: { byUrgency: Analytics['byUrgency'] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">By urgency</CardTitle>
        <CardDescription>
          Median and 90th-percentile time from report to responder, per urgency band.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <table className="w-full text-left text-sm">
          <caption className="sr-only">
            Response time percentiles for each urgency band, in minutes.
          </caption>
          <thead>
            <tr>
              <th scope="col" className="uppercase-label py-2 pr-3 text-muted">
                Urgency
              </th>
              <th scope="col" className="uppercase-label py-2 pr-3 text-muted">
                Target
              </th>
              <th scope="col" className="uppercase-label py-2 pr-3 text-muted">
                Median
              </th>
              <th scope="col" className="uppercase-label py-2 text-muted">
                90th percentile
              </th>
            </tr>
          </thead>
          <tbody>
            {byUrgency.map((row) => (
              <tr key={row.urgency} className="border-t border-subtle">
                <th scope="row" className="py-2 pr-3 text-left font-medium text-primary">
                  {URGENCY_META[row.urgency].label}
                </th>
                <td className="py-2 pr-3 tabular text-secondary">
                  {URGENCY_META[row.urgency].slaMinutes} min
                </td>
                <td className="py-2 pr-3 tabular text-secondary">
                  {formatDuration(row.p50Sec)}
                </td>
                <td className="py-2 tabular text-secondary">{formatDuration(row.p90Sec)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Table alternatives and screen-reader sentences                               */
/* -------------------------------------------------------------------------- */

function categoryTable(rows: Analytics['byCategory']): ChartSeries {
  return {
    columns: ['Category', 'Incidents', 'Of which critical'],
    rows: rows
      .filter((row) => row.count > 0)
      .map((row) => [
        CATEGORY_META[row.category].label,
        formatCount(row.count),
        formatCount(row.critical),
      ]),
  };
}

function categorySrText(rows: Analytics['byCategory']): string {
  const top = [...rows].filter((r) => r.count > 0).sort((a, b) => b.count - a.count).slice(0, 3);
  const spoken = top
    .map((row) => `${CATEGORY_META[row.category].label} ${formatCount(row.count)}`)
    .join(', ');
  return `Bar chart of incidents by category. The three largest are ${spoken}. Open “View as table” for every category.`;
}

function trendTable(rows: Analytics['trend']): ChartSeries {
  return {
    columns: ['Bucket', 'Created', 'Resolved', 'Critical'],
    rows: rows.map((row) => [
      row.bucket,
      formatCount(row.created),
      formatCount(row.resolved),
      formatCount(row.critical),
    ]),
  };
}

function trendSrText(rows: Analytics['trend']): string {
  const totalCreated = rows.reduce((sum, row) => sum + row.created, 0);
  const totalResolved = rows.reduce((sum, row) => sum + row.resolved, 0);
  return `Line chart comparing incidents created with incidents resolved across ${rows.length} buckets. ${formatCount(totalCreated)} created and ${formatCount(totalResolved)} resolved in total. Open “View as table” for each bucket.`;
}

function responseTable(buckets: Analytics['responseBuckets']): ChartSeries {
  return {
    columns: ['Time band', 'Incidents'],
    rows: buckets.map((bucket) => [bucket.label, formatCount(bucket.count)]),
  };
}

function responseSrText(
  buckets: Analytics['responseBuckets'],
  byUrgency: Analytics['byUrgency'],
): string {
  const slowest = buckets[buckets.length - 1];
  return `Histogram of response times in ${buckets.length} bands, with median and 90th-percentile figures for each of the ${byUrgency.length} urgency bands below it. The longest band is ${slowest?.label ?? 'not recorded'}. Open “View as table” for every band.`;
}
