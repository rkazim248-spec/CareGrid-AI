'use client';


import * as React from 'react';

import { PageHeader } from '@/components/layout';
import { HistoryView } from '@/features/incidents/history-view';
import { MyReportsList } from '@/features/incidents/my-reports-list';
import { useResolvedSession } from '@/components/providers/session-provider';

/**
 * The role branch for `/incidents` (docs/04 §13.8, §12.1).
 *
 * A citizen gets "My reports" and nothing else — no pagination, no terminal
 * statuses, no deleted rows, no export. An operations role gets the archive. The
 * split is here rather than in the page so the page stays a server component and
 * the `<h1>` count stays at one per variant.
 *
 * From Phase 2 the SERVER decides which of these two the response contains at all;
 * this client branch stops being load-bearing (docs/22 §6 layer 2).
 */
export function RoleScopedIncidents() {

  const { role } = useResolvedSession();

  if (role === 'citizen') {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="My reports"
          description="Every report you have filed, with its current status and last update."
        />
        <MyReportsList />
      </div>
    );
  }


  return <HistoryView />;
}
