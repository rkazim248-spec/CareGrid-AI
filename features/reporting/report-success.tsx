'use client';

import * as React from 'react';
import Link from 'next/link';
import { Check, Copy, Share2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button, Card, CardContent } from '@/components/ui';
import { DEMO_REFERENCE, REPORT_COPY } from '@/features/reporting/report-copy';

/**
 * Report success screen — docs/04 §13.2 Success, §14.1 `report.success`.
 *
 * `role="status"` and focus moved to the heading (US-001 AC3). The reference is
 * the single most important thing on the screen, so it is the largest type on
 * the screen and monospaced, with a reserved width so nothing reflows when it
 * is copied (docs/04 §3.3).
 *
 * The buttons are UI only in Phase 1: the reference is not real, so `Share`
 * degrades to copying the link and says which one it did.
 */
export function ReportSuccess() {
  const headingRef = React.useRef<HTMLHeadingElement | null>(null);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const trackHref = `/track?ref=${DEMO_REFERENCE}`;

  const copy = React.useCallback(() => {
    const absolute = `${window.location.origin}${trackHref}`;
    void navigator.clipboard
      ?.writeText(absolute)
      .then(() => {
        setCopied(true);
        toast.success('Reference copied', { description: `${DEMO_REFERENCE} is on your clipboard.` });
      })
      .catch(() => {
        toast.error('Nothing was copied', { description: 'Copy the reference by hand from the screen.' });
      });
  }, [trackHref]);

  const share = React.useCallback(() => {
    const absolute = `${window.location.origin}${trackHref}`;
    if (typeof navigator.share === 'function') {
      navigator.share({ title: 'CareGrid AI report', text: `Track report ${DEMO_REFERENCE}`, url: absolute }).catch(() => undefined);
      return;
    }
    copy();
  }, [copy, trackHref]);

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
            <p className="ref-code text-5xl text-primary">{DEMO_REFERENCE}</p>
          </div>

          <p className="max-w-[52ch] text-sm text-secondary">{REPORT_COPY.successBody}</p>

          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
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

      <div className="flex flex-col items-center gap-2">
        <Button asChild variant="primary" size="lg" className="w-full sm:w-auto">
          <Link href={trackHref}>{REPORT_COPY.trackLink}</Link>
        </Button>
        <p className="text-xs text-muted">
          In this build the reference belongs to the sample dataset, not to a stored report.
        </p>
      </div>
    </div>
  );
}
