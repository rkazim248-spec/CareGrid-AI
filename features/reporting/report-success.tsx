'use client';

import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, Check, Copy, Share2 } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertIcon, AlertTitle, Button, Card, CardContent } from '@/components/ui';
import { REPORT_COPY } from '@/features/reporting/report-copy';
import { URGENCY_META } from '@/config';
import type { CreatedIncident } from '@/features/reporting/report-form';
import type { Route } from 'next';

/**
 * Report success screen — docs/04 §13.2 Success, §14.1 `report.success`.
 *
 * ---------------------------------------------------------------------------
 * THIS SCREEN NOW RENDERS A REAL INCIDENT
 * ---------------------------------------------------------------------------
 * It used to take no props and print `DEMO_REFERENCE`, so it told a citizen that
 * `CG-7F2QX4` had been submitted when nothing had been submitted at all. The
 * created incident is now a required prop, which means this component cannot render
 * a fabricated reference even by accident — there is no fallback value to reach for.
 *
 * `role="status"` and focus moved to the heading (US-001 AC3) are unchanged. The
 * reference remains the largest, monospaced element with a reserved width, so
 * nothing reflows when it is copied (docs/04 §3.3).
 *
 * ---------------------------------------------------------------------------
 * THE DEGRADED SUBSTATES ARE SHOWN, NOT SWALLOWED
 * ---------------------------------------------------------------------------
* `evidenceDroppedMediaCount` and the `warnings` array are rendered as plain
 * sentences. The reason is that the create route deliberately drops files rather
 * than failing a report, so a citizen whose fourth photo did not make it has
 * genuinely lost something - and the alternative, showing a cheerful "2 photos
 * attached" screen with no mention of the third, is the dishonest outcome.
 *
 * The dropped-media alert deliberately makes NO offer to add the file afterwards.
 * There is no "add evidence to a report" flow, and telling a citizen they can do
 * that sends them to a dead end after a moment of real frustration. It states what
 * happened and points at the reference they can quote - which is the one recovery
 * path that genuinely exists.
 *
 * This is the FR-029 pattern applied to the client: a degradation the reporter needs
 * to know about is stated, and it never turns into a failure they did not cause.
 */
export function ReportSuccess({ created }: { created: CreatedIncident }) {
  const headingRef = React.useRef<HTMLHeadingElement | null>(null);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // The incidentId, not the reference: the reference is what the citizen quotes to
  // an operator, and the tracking route reads the id. `encodeURIComponent` because
  // it lands in a URL query and the id is server-generated but still interpolated.
  const trackHref = `/track?ref=${encodeURIComponent(created.reference)}` as Route;
  const incidentHref = `/incidents/${encodeURIComponent(created.incidentId)}` as Route;

  const trackUrl = React.useCallback(() => {
    if (typeof window === 'undefined') return trackHref;
    return `${window.location.origin}${trackHref}`;
  }, [trackHref]);

  const copy = React.useCallback(() => {
    void navigator.clipboard
      ?.writeText(created.reference)
      .then(() => {
        setCopied(true);
        toast.success('Reference copied', { description: `${created.reference} is on your clipboard.` });
      })
      .catch(() => {
        toast.error('Nothing was copied', { description: 'Copy the reference by hand from the screen.' });
      });
  }, [created.reference]);

  const share = React.useCallback(() => {
    const absolute = trackUrl();
    if (typeof navigator.share === 'function') {
      navigator
        .share({ title: 'CareGrid AI report', text: `Track report ${created.reference}`, url: absolute })
        // A dismissed share sheet rejects; that is not an error worth a toast.
        .catch(() => undefined);
      return;
    }
    copy();
  }, [copy, created.reference, trackUrl]);

  const urgency = URGENCY_META[created.urgency];
  const notes = describeWarnings(created);
  const dropped = created.droppedMedia.length;
  const usedFallback = created.triageSource !== 'ai';

  return (
    <div role="status" className="flex flex-col gap-5">
      <Card>
        <CardContent className="flex flex-col items-center gap-4 px-4 py-8 text-center">
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="text-2xl font-semibold text-primary focus:outline-none"
          >
            {REPORT_COPY.successTitle}
          </h2>

          <div className="flex flex-col items-center gap-1">
            <p className="uppercase-label text-muted">{REPORT_COPY.referenceLabel}</p>
            <p className="ref-code text-5xl text-primary">{created.reference}</p>
          </div>

          <p className="max-w-[52ch] text-sm text-secondary">{REPORT_COPY.successBody}</p>

          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            <Button asChild variant="primary" size="lg" className="sm:w-auto">
              <Link href={incidentHref}>View saved incident</Link>
            </Button>
            <Button type="button" variant="outline" size="lg" onClick={copy} className="sm:w-auto">
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copied ? 'Copied' : REPORT_COPY.copyReference}
            </Button>
            <Button type="button" variant="outline" size="lg" onClick={share} className="sm:w-auto">
              <Share2 aria-hidden="true" />
              {REPORT_COPY.share}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* What was actually recorded. The citizen's own words back to them is the
          cheapest possible confirmation that a real document was written, and it
          doubles as the "did my text go through?" check they are about to want. */}
      <Card>
        <CardContent className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-primary">What we recorded</h3>

          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-secondary">Category</dt>
            {/* `category` is NULLABLE by contract — "null when triage could not
                classify it, never defaulted to 'other'". So this screen says so
                rather than substituting a plausible-sounding value. A citizen who
                sees "Medical" when the model guessed would act on a guess. */}
            <dd className="text-primary">
              {created.category === null
                ? 'Not classified — a person will review this'
                : created.category.replace(/_/g, ' ')}
            </dd>

            <dt className="text-secondary">Urgency</dt>
            <dd className="flex items-center gap-2 text-primary">
              <span aria-hidden="true" className={`inline-block size-2 rounded-full ${urgency.bgClass}`} />
              {urgency.label}
            </dd>

            <dt className="text-secondary">Attachments</dt>
            <dd className="text-primary">
              {created.evidenceCount === 0
                ? 'None'
                : `${created.evidenceCount} file${created.evidenceCount === 1 ? '' : 's'}`}
            </dd>
          </dl>

          {/* The AI's own summary of what it was shown. Quoted rather than restated
              as fact — it is a model's reading of the report, and `usedFallback`
              below says plainly when it was not a model at all. */}
          <div className="rounded-lg border border-subtle bg-surface-2 p-3">
            <p className="text-xs font-medium text-secondary">
              {usedFallback ? 'Automatic summary (assistant offline)' : 'AI summary'}
            </p>
            <p className="mt-1 text-sm text-primary">{created.summary}</p>
          </div>

          {created.duplicateStatus === 'potential_duplicate' ? (
            <Alert tone="info">
              <AlertIcon tone="info" />
              <div className="flex min-w-0 flex-col gap-1">
                <AlertTitle>This may be a repeat report</AlertTitle>
                <AlertDescription>
                  It looks similar to an earlier report nearby. We have flagged both for a
                  responder to check, so you do not need to send it again.
                </AlertDescription>
              </div>
            </Alert>
          ) : null}

          {/* Degradations, stated plainly. Never a failure — the report exists. */}
          {dropped > 0 ? (
            <Alert tone="warning">
              <AlertIcon tone="warning" />
              <div className="flex min-w-0 flex-col gap-1">
                <AlertTitle>
                  {dropped} file{dropped === 1 ? '' : 's'} could not be attached
                </AlertTitle>
                <AlertDescription>
                  Your report was sent successfully without {dropped === 1 ? 'it' : 'them'}. The
                  rest of the report is complete and tracked under{' '}
                  <span className="font-mono">{created.reference}</span>.
                </AlertDescription>
              </div>
            </Alert>
          ) : null}

          {notes.length > 0 ? (
            <ul className="flex flex-col gap-1 text-xs text-secondary">
              {notes.map((note) => (
                <li key={note} className="flex items-start gap-1.5">
                  <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                  {note}
                </li>
              ))}
            </ul>
          ) : null}
        </CardContent>
      </Card>

      <div className="flex flex-col items-center gap-2">
        <Button asChild variant="primary" size="lg" className="w-full sm:w-auto">
          <Link href={trackHref}>{REPORT_COPY.trackLink}</Link>
        </Button>
      </div>
    </div>
  );
}

/**
 * Turn the response's warning codes into sentences a person can act on.
 *
 * An unknown code is rendered as its own name rather than dropped, because a new
 * code should be visible in the UI before someone writes copy for it — a silently
 * ignored warning is how "we never told the citizen their location failed" happens.
 */
function describeWarnings(created: CreatedIncident): string[] {
  const notes: string[] = [];

  for (const code of created.warnings) {
    switch (code) {
      case 'storage_unavailable':
        notes.push('Our photo storage was briefly unavailable, so some files may not have been kept.');
        break;
      case 'evidence_dropped':
        // Already covered by its own Alert above; saying it twice is noise.
        break;
      case 'duplicate_check_unavailable':
        notes.push('We could not check for nearby duplicate reports this time.');
        break;
      case 'location_ungeocoded':
        notes.push('We could not match the address you typed, so this report has no map pin.');
        break;
      case 'location_too_coarse':
        notes.push('The address you typed was too broad to place, so this report has no map pin.');
        break;
      default:
        notes.push(`Note from the reporting service: ${code}.`);
    }
  }

  if (created.triageSource !== 'ai' && !created.warnings.includes('triage_unavailable')) {
    notes.push('The AI assistant is offline, so the category and urgency were assigned automatically.');
  }

  if (created.aiNeedsReview) {
    notes.push('A person will check the classification before it is used.');
  }

  return notes;
}