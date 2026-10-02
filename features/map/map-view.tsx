'use client';

import { Alert, AlertDescription, AlertIcon, AlertTitle } from '@/components/ui';
import { PageHeader } from '@/components/layout';
import { MyReportsList } from '@/features/incidents/my-reports-list';

export function MapView() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Map"
        description="Review saved incident locations and open the authorized incident record."
      />

      <Alert tone="neutral">
        <AlertIcon tone="neutral" />
        <div className="flex min-w-0 flex-col gap-1">
          <AlertTitle>Live map rendering is unavailable</AlertTitle>
          <AlertDescription>
            This build does not have a connected map renderer. The incident list below uses saved,
            caller-authorized report data; no sample markers or guessed locations are shown.
          </AlertDescription>
        </div>
      </Alert>

      <MyReportsList searchLabel="Search incidents by reference, summary, or place" />
    </div>
  );
}
