'use client';

import * as React from 'react';
import { Mic, Square } from 'lucide-react';

import { Alert, AlertDescription, AlertIcon, AlertTitle, Button } from '@/components/ui';
import { REPORT_COPY } from '@/features/reporting/report-copy';
import { formatCountdown } from '@/lib/format';
import { REPORT_LIMITS } from '@/config';

/**
 * Voice note recorder UI — docs/04 §13.2 Components (`useMediaRecorder`).
 *
 * There is NO `MediaRecorder` in Phase 1 and none is requested from the user:
 * asking for the microphone and then not recording is a worse experience than
 * saying plainly that the affordance is not live. The 56px target, the elapsed
 * readout, and the state copy are all in place so the reviewed layout is the
 * layout that ships.
 *
 * The record button uses the FR-017 disabled-with-reason pattern
 * (docs/04 §10.4): `aria-disabled` keeps it in the tab order, and activating it
 * moves focus to the visible reason instead of doing nothing silently.
 */
export function VoiceRecorder() {
  const reasonRef = React.useRef<HTMLParagraphElement | null>(null);
  const reasonId = 'report-voice-reason';

  const showReason = React.useCallback(() => {
    reasonRef.current?.focus();
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <Alert tone="neutral">
        <AlertIcon tone="neutral" />
        <div className="flex min-w-0 flex-col gap-1">
          <AlertTitle>{REPORT_COPY.voiceStateTitle}</AlertTitle>
          <AlertDescription>{REPORT_COPY.voiceStateBody}</AlertDescription>
        </div>
      </Alert>

      <div className="flex flex-wrap items-center gap-4">
        <Button
          type="button"
          variant="secondary"
          size="xl"
          className="min-w-14 rounded-pill"
          // Not `disabled`: the control stays focusable and explains itself.
          aria-disabled="true"
          aria-describedby={reasonId}
          onClick={showReason}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              showReason();
            }
          }}
        >
          <Mic aria-hidden="true" />
          <span className="sr-only">{REPORT_COPY.voiceRecordLabel}</span>
        </Button>

        <p className="flex items-baseline gap-2 text-sm text-secondary">
          <span>{REPORT_COPY.voiceElapsedLabel}</span>
          <span className="text-base text-primary tabular">{formatCountdown(0)}</span>
          <span className="text-xs text-muted">
            limit {REPORT_LIMITS.maxAudioDurationSec} s
          </span>
        </p>
      </div>

      <p
        ref={reasonRef}
        id={reasonId}
        tabIndex={-1}
        className="text-xs text-warning focus:outline-none"
      >
        {REPORT_COPY.voiceDisabledReason}
      </p>

      <p className="flex items-center gap-2 text-xs text-muted">
        <Square className="size-3" aria-hidden="true" />
        Recording is not running.
      </p>
    </div>
  );
}
