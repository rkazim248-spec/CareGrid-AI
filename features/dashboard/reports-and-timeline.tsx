'use client';

import * as React from 'react';
import { FileText, Images, Mic, UserRound } from 'lucide-react';

import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui';
import { SectionHeader } from '@/components/layout';
import { RelativeTime, Timeline } from '@/components/domain';
import { MOCK_HISTORY_BY_INCIDENT, MOCK_REPORTS_BY_INCIDENT } from '@/lib/mock-data';
import { formatCount } from '@/lib/format';
import type { Incident, IncidentReport, UserRole } from '@/types';

/**
 * ReportsAndTimeline — docs/04 §13.9, §5.25, FR-003, FR-068.
 *
 * Two rules that this block exists to hold:
 *
 *  1. The reporter's words are shown VERBATIM inside an inset well and are
 *     never re-written, summarised, or auto-corrected (FR-003). The `originalText`
 *     is a legal record of what someone said, not content to be tidied up.
 *  2. A responder never sees a reporter name (FR-068). The `showReporter` prop
 *     comes from the ROLE, not from the data being available, so a future refactor
 *     cannot accidentally start leaking a name to a responder.
 */
export function ReportsAndTimeline({
  incident,
  role,
  className,
}: {
  incident: Incident;
  role: UserRole;
  className?: string;
}) {
  const showReporter = role === 'dispatcher' || role === 'admin';
  const reports = MOCK_REPORTS_BY_INCIDENT[incident.incidentId] ?? [];
  const history = MOCK_HISTORY_BY_INCIDENT[incident.incidentId] ?? [];

  return (
    <div className={className}>
      <SectionHeader
        title={`Reports (${formatCount(reports.length)})`}
        description="Every report for this incident, exactly as it was sent. The text is never re-written."
      />

      <ul className="mt-3 flex flex-col gap-3">
        {reports.map((report, index) => (
          <li key={report.reportId}>
            <ReportCard
              report={report}
              index={index + 1}
              showReporter={showReporter}
              primaryText={incident.originalText}
            />
          </li>
        ))}
        {reports.length === 0 ? (
          <li className="text-sm text-secondary">
            Only the original report is stored with this incident.
          </li>
        ) : null}
      </ul>

      <SectionHeader title="Timeline" className="mt-8" />
      <div className="mt-3">
        <Timeline events={history} variant="compact" />
      </div>
    </div>
  );
}

const KIND_LABEL: Record<IncidentReport['kind'], string> = {
  original: 'Original report',
  duplicate_link: 'Linked report',
  supplement: 'Extra detail',
  correction: 'Correction',
};

function ReportCard({
  report,
  index,
  showReporter,
  primaryText,
}: {
  report: IncidentReport;
  index: number;
  showReporter: boolean;
  primaryText: string;
}) {
  const text = report.text ?? primaryText;

  return (
    <Card>
      <CardHeader className="gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">
            <span className="tabular text-muted">{index}</span> ·{' '}
            {KIND_LABEL[report.kind]}
          </CardTitle>
          <RelativeTime iso={report.createdAt} />
          {report.similarityToPrimary === null ? null : (
            <Badge variant="muted" size="sm" className="tabular">
              {Math.round(report.similarityToPrimary * 100)}% similar
            </Badge>
          )}
        </div>

        {showReporter && report.reporter ? (
          <p className="flex items-center gap-1.5 text-xs text-secondary">
            <UserRound className="size-3.5" aria-hidden="true" />
            Sent by {report.reporter.displayName}
          </p>
        ) : (
          <p className="text-xs text-muted">The reporter’s name is not shown to responders.</p>
        )}
      </CardHeader>

      <CardContent className="flex flex-col gap-2">
        <div className="rounded-sm border border-subtle bg-inset p-3">
          <p className="uppercase-label mb-1.5 text-muted">Original text — verbatim</p>
          <p className="max-w-[72ch] text-sm whitespace-pre-wrap text-primary">{text}</p>
        </div>

        {report.media.length > 0 ? (
          <p className="flex flex-wrap items-center gap-2 text-xs text-secondary">
            {report.media.some((m) => m.kind === 'image') ? (
              <span className="inline-flex items-center gap-1">
                <Images className="size-3.5" aria-hidden="true" />
                {formatCount(report.media.filter((m) => m.kind === 'image').length)} photos
              </span>
            ) : null}
            {report.media.some((m) => m.kind === 'audio') ? (
              <span className="inline-flex items-center gap-1">
                <Mic className="size-3.5" aria-hidden="true" />
                {formatCount(report.media.filter((m) => m.kind === 'audio').length)} voice note
              </span>
            ) : null}
            <span className="text-muted">Media previews arrive with real storage in a later phase.</span>
          </p>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <FileText className="size-3.5" aria-hidden="true" />
            Text only, no media attached.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
