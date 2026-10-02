'use client';

import * as React from 'react';
import { ClipboardList } from 'lucide-react';

import { ErrorState, EMPTY_COPY, EmptyState } from '@/components/feedback';
import { Button } from '@/components/ui';
import { listIncidents } from '@/lib/api/client';
import { MyReportCard } from '@/features/incidents/my-report-card';
import { MyReportsFilters } from '@/features/incidents/my-reports-filters';
import type { IncidentStatus } from '@/types';
import type { z } from 'zod';
import type { incidentListResponseSchema } from '@/validators/incident';

type IncidentRow = z.infer<typeof incidentListResponseSchema>['items'][number];

export function MyReportsList({ searchLabel }: { searchLabel?: string } = {}) {
  const [items, setItems] = React.useState<readonly IncidentRow[]>([]);
  const [hasMore, setHasMore] = React.useState(false);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const [status, setStatus] = React.useState<IncidentStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState(false);
  const [moreError, setMoreError] = React.useState(false);
  const [reload, setReload] = React.useState(0);

  React.useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);

    void listIncidents({ limit: '100' }, { signal: controller.signal })
      .then((result) => {
        setItems(result.items);
        setHasMore(result.page.hasMore);
        setNextCursor(result.page.nextCursor);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [reload]);

  const loadMore = React.useCallback(async () => {
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    setMoreError(false);
    try {
      const result = await listIncidents({ limit: '100', cursor: nextCursor });
      setItems((current) => {
        const seen = new Set(current.map((item) => item.incidentId));
        return [...current, ...result.items.filter((item) => !seen.has(item.incidentId))];
      });
      setHasMore(result.page.hasMore);
      setNextCursor(result.page.nextCursor);
    } catch {
      setMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, nextCursor]);

  const visible = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((incident) => {
      if (status && incident.status !== status) return false;
      if (!needle) return true;
      return [incident.reference, incident.summary, incident.placeName ?? '']
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
  }, [items, query, status]);

  return (
    <div className="flex flex-col gap-5">
      <MyReportsFilters
        query={query}
        onQueryChange={setQuery}
        status={status}
        onStatusChange={setStatus}
        searchLabel={searchLabel}
      />

      {loading ? (
        <ul className="flex flex-col gap-3" aria-label="Loading reports">
          {[0, 1, 2].map((item) => (
            <li key={item} className="skeleton-fill h-28 rounded-card" />
          ))}
        </ul>
      ) : error ? (
        <ErrorState
          title="We could not load your reports"
          description="Your reports have not been changed. Check your connection and try again."
          onRetry={() => setReload((value) => value + 1)}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title={items.length === 0 ? EMPTY_COPY.reports.title : 'No reports match these filters'}
          description={
            items.length === 0
              ? EMPTY_COPY.reports.description
              : 'Clear the search or choose a different status to see your reports.'
          }
          action={
            items.length === 0
              ? { label: EMPTY_COPY.reports.actionLabel, href: '/report' }
              : { label: 'Clear filters', onClick: () => { setQuery(''); setStatus(null); } }
          }
        />
      ) : (
        <>
          <p className="text-xs text-secondary tabular-nums">
            {visible.length} {visible.length === 1 ? 'report' : 'reports'}
            {hasMore ? ' shown; more reports are available.' : ''}
          </p>
          <ul className="flex flex-col gap-3">
            {visible.map((incident) => (
              <MyReportCard key={incident.incidentId} incident={incident} />
            ))}
          </ul>
          {hasMore ? (
            <Button variant="outline" className="self-start" loading={loadingMore} onClick={() => void loadMore()}>
              Load more reports
            </Button>
          ) : null}
          {moreError ? (
            <p role="alert" className="text-sm text-danger-fg-muted">
              We could not load the next page. Your loaded reports are still available.
              <button type="button" className="ml-1 underline underline-offset-2" onClick={() => void loadMore()}>
                Try again
              </button>
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
