'use client';

import * as React from 'react';

import { Alert, AlertDescription, AlertIcon, AlertTitle } from '@/components/ui';
import { DemoDataBadge } from '@/components/feedback';
import { REPORT_COPY } from '@/features/reporting/report-copy';
import { ReportForm } from '@/features/reporting/report-form';
import { ReportSuccess } from '@/features/reporting/report-success';

/**
 * /report — docs/04_UI_UX_DESIGN_SPECIFICATION.md §13.2.
 *
 * Owns one piece of state: submitted or not. Everything else lives in
 * `ReportForm`, so a swap to a real `POST /api/incidents` touches this file and
 * the form, not the whole route.
 *
 * The phase notice is a permanent `neutral` Alert, not a toast: a citizen must
 * never believe a report reached a dispatcher from this build
 * (docs/04 §15.5).
 */
export function ReportView() {
  const [submitted, setSubmitted] = React.useState(false);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <DemoDataBadge />
        <Alert tone="neutral">
          <AlertIcon tone="neutral" />
          <div className="flex min-w-0 flex-col gap-1">
            <AlertTitle>Sample build, nothing is sent</AlertTitle>
            <AlertDescription>{REPORT_COPY.phaseNotice}</AlertDescription>
          </div>
        </Alert>
      </div>

      {submitted ? (
        <ReportSuccess />
      ) : (
        <ReportForm onSubmitted={() => setSubmitted(true)} />
      )}
    </div>
  );
}
