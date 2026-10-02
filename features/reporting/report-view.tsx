'use client';

import * as React from 'react';

import { Alert, AlertDescription, AlertIcon, AlertTitle } from '@/components/ui';
import { ReportForm, type CreatedIncident } from '@/features/reporting/report-form';
import { ReportSuccess } from '@/features/reporting/report-success';

/**
 * /report — docs/04_UI_UX_DESIGN_SPECIFICATION.md §13.2.
 *
 * ---------------------------------------------------------------------------
 * THIS VIEW NOW HOLDS THE CREATED INCIDENT, NOT A BOOLEAN
 * ---------------------------------------------------------------------------
 * It previously owned `submitted: boolean`, which is why the success screen had to
 * invent a reference — there was nothing real to show it. The state is now the
 * incident itself, so `ReportSuccess` receives what the server actually stored.
 *
 * The consequence worth stating: there is no longer any code path on which this
 * view renders a success screen for a report that was not created. `created` is
 * `null` or it is a real incident.
 *
 * ---------------------------------------------------------------------------
 * THE "SAMPLE BUILD, NOTHING IS SENT" BANNER IS GONE, AND THE SAFETY DISCLAIMER IS NOT
 * ---------------------------------------------------------------------------
 * The old banner said reports did not reach anyone, which stopped being true once
 * `POST /api/incidents` was wired — and a banner that lies in the reassuring
 * direction is worse than none. `DemoDataBadge` went with it.
 *
 * What REPLACES it is a different claim, and it is a real one: CareGrid routes and
 * assists emergency reports, and it is **not** an emergency service. That has to be
 * on the form before someone types, not discovered afterwards, and it stays in the
 * same permanent non-dismissible Alert that the phase notice used — a toast would
 * let it be missed at exactly the moment it matters.
 */
export function ReportView() {
  const [created, setCreated] = React.useState<CreatedIncident | null>(null);

  if (created !== null) {
    return <ReportSuccess created={created} />;
  }

  return (
    <div className="flex flex-col gap-6">
      <Alert tone="neutral">
        <AlertIcon tone="neutral" />
        <div className="flex min-w-0 flex-col gap-1">
          <AlertTitle>If this is an emergency, call your local emergency number first</AlertTitle>
          <AlertDescription>
            CareGrid AI helps route and assist reports. It does not replace emergency
            services, and a report sent here does not page anyone directly. Do not wait
            for a response here before calling for help.
          </AlertDescription>
        </div>
      </Alert>

      <ReportForm onSubmitted={setCreated} />
    </div>
  );
}