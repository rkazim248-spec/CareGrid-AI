'use client';


import * as React from 'react';
import { Download, Inbox } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertIcon, AlertTitle, Button, Pagination } from '@/components/ui';
import { PageHeader } from '@/components/layout';
import { DemoDataBadge, EMPTY_COPY } from '@/components/feedback';
import { MOCK_INCIDENTS } from '@/lib/mock-data';
import {
  EMPTY_HISTORY_QUERY,
  HistoryFilters,
  matchesHistoryQuery,
} from '@/features/incidents/history-filters';
import type { HistoryQuery } from '@/features/incidents/history-filters';
import { HistoryCards, HistoryTable } from '@/features/incidents/history-table';
import { useResolvedSession } from '@/components/providers/session-provider';

/**
 * HistoryView — `/incidents`, the role-scoped archive (docs/04 §13.8).
 *
 * Deliberately DISTINCT from the dashboard queue. The queue is "what needs
 * attention now"; this is "what happened, and when" — so the status filter here
 * includes the terminal statuses the live queue never shows, rows are DATED
 * rather than aged against a live clock, and pagination is by page over a
 * client-side slice because Phase 1 has no cursor.
 *
 * `Export CSV` is a real permission boundary in the UI (FR-118): a responder or
 * citizen sees the control DISABLED with the reason rendered as visible text,
 * not hidden (docs/04 §10.4). The API re-checks it from Phase 2.
 */

const PAGE_SIZES = [10, 25, 50] as const;
const EXPORT_REASON = 'Available to dispatchers and administrators';

export function HistoryView() {

  const { role } = useResolvedSession();
  const [query, setQuery] = React.useState<HistoryQuery>(EMPTY_HISTORY_QUERY);
  const [pageSize, setPageSize] = React.useState<number>(10);
  const [page, setPage] = React.useState(0);

  const canExport = role === 'dispatcher' || role === 'admin';

  const rows = React.useMemo(
    () => MOCK_INCIDENTS.filter((incident) => matchesHistoryQuery(incident, query)),
    [query],
  );

  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(page, pageCount - 1);
  const visible = rows.slice(current * pageSize, current * pageSize + pageSize);
  const firstIndex = rows.length === 0 ? 0 : current * pageSize + 1;
  const lastIndex = Math.min(rows.length, (current + 1) * pageSize);


  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Incidents"
        description="The full record for this area, including closed, cancelled and deleted reports. This is history, not the live queue."
        meta={
          <span className="flex flex-wrap items-center gap-2 text-xs text-secondary">
            <DemoDataBadge />
            Every record on this page is fabricated for the UI shell.
          </span>
        }
        actions={[
          {
            label: 'Export CSV',
            variant: 'outline',
            icon: Download,
            onClick: () =>
              toast.info('Export CSV', {
                description: 'Demo build — no file is produced. A real export follows your current filters.',
              }),
            ...(canExport ? {} : { disabledReason: EXPORT_REASON }),
          },
        ]}
      />

      <HistoryFilters
        query={query}
        onQueryChange={(next) => {
          setQuery(next);
          setPage(0);
        }}
        resultCount={rows.length}
        onReset={() => {
          setQuery(EMPTY_HISTORY_QUERY);
          setPage(0);
        }}
      />

      <Alert tone="warning">
        <AlertIcon tone="warning" />
        <div>
          <AlertTitle>Deleted records are visible to operations roles only</AlertTitle>
          <AlertDescription>
            Actions taken here are recorded in the audit log with your name and the reason you give.
          </AlertDescription>
        </div>
      </Alert>

      {rows.length === 0 ? (
        <HistoryEmpty
          onChangeDates={() => {
            setQuery({ ...query, from: '', to: '' });
            setPage(0);
          }}
        />
      ) : (
        <>
          <div className="hidden md:block">
            <HistoryTable rows={visible} />
          </div>
          <div className="md:hidden">
            <HistoryCards rows={visible} />
          </div>

          <Pagination
            rowLabel={`Rows ${firstIndex}–${lastIndex} of ${rows.length}`}
            hasPrevious={current > 0}
            hasNext={current < pageCount - 1}
            onPrevious={() => setPage((p) => Math.max(0, p - 1))}
            onNext={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            pageSize={pageSize}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(0);
            }}
            pageSizeOptions={PAGE_SIZES}
          />
        </>
      )}
    </div>
  );
}

/** `EMPTY_COPY.history` verbatim — the page never invents its own empty state. */
function HistoryEmpty({ onChangeDates }: { onChangeDates: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-default bg-surface px-6 py-12 text-center">
      <Inbox className="size-icon-2xl text-muted" aria-hidden="true" />
      <h2 className="text-lg font-semibold text-primary">{EMPTY_COPY.history.title}</h2>
      <p className="max-w-[52ch] text-sm text-secondary">
        {EMPTY_COPY.history.description}
      </p>
      <Button variant="secondary" onClick={onChangeDates} className="mt-1 min-h-11">
        {EMPTY_COPY.history.actionLabel}
      </Button>
    </div>
  );
}
