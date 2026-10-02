'use client';

import { PageHeader } from '@/components/layout';
import { MyReportsList } from '@/features/incidents/my-reports-list';

export function HistoryView() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Incident history"
        description="Review saved incidents available to your account. Search by reference, summary, or place and filter by status."
      />
      <MyReportsList searchLabel="Search incidents" />
    </div>
  );
}
