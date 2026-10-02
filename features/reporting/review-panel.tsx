'use client';

import { Card, CardContent, CardHeader } from '@/components/ui';
import { CATEGORY_META } from '@/config';
import { REPORT_COPY } from '@/features/reporting/report-copy';
import { ReportStepHeading } from '@/features/reporting/report-step-heading';
import { formatAccuracy } from '@/lib/format';
import type { ReportDraft } from '@/features/reporting/report-types';

/**
 * The review block — docs/04 §13.2 Success / §10.4.
 *
 * A person in a stressful situation should be able to see what is about to be
 * sent without scrolling back up the form. Four labelled rows, no jargon, and
 * an explicit "not provided" rather than a blank cell: a blank reads as a bug.
 */
export function ReviewPanel({ draft }: { draft: ReportDraft }) {
  const evidenceCount = draft.evidence.length;
  const hasLocation = draft.location.source !== 'none';

  const rows: readonly { label: string; value: string }[] = [
    {
      label: 'Report',
      value:
        draft.text.trim().length === 0
          ? 'No description yet'
          : `${draft.text.trim().length} characters, ${evidenceCount} evidence item${evidenceCount === 1 ? '' : 's'}`,
    },
    {
      label: 'Location',
      value: hasLocation ? formatAccuracy(draft.location.accuracyM) : 'Not provided',
    },
    {
      label: 'Evidence',
      value:
        evidenceCount === 0
          ? 'None added'
          : `${evidenceCount} item${evidenceCount === 1 ? '' : 's'}`,
    },
    {
      label: 'Category',
      value: draft.category ? CATEGORY_META[draft.category].label : 'AI will suggest one',
    },
  ];

  return (
    <Card className="border-default">
      <CardHeader>
        <ReportStepHeading number={5} title={REPORT_COPY.reviewTitle} />
      </CardHeader>
      <CardContent>
        <dl className="flex flex-col gap-2">
          {rows.map((row) => (
            <div key={row.label} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <dt className="w-24 shrink-0 text-xs text-muted">{row.label}</dt>
              <dd className="min-w-0 flex-1 text-sm text-primary">{row.value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
