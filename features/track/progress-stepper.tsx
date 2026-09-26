'use client';

import { Check } from 'lucide-react';

import { cn } from '@/lib/cn';
import { formatClock, formatAbsolute } from '@/lib/format';
import { TRACK_COPY } from '@/features/track/track-copy';
import type { TrackStep } from '@/features/track/track-progress';

/**
 * The lifecycle stepper — docs/04 §13.3.
 *
 * Vertical, because seven labelled steps at 360 px in a row is unreadable, and a
 * citizen reading this on a phone is the primary case (docs/04 §1.2 P8).
 *
 * Three states, and the state is never carried by colour alone: a filled tick
 * for done, a ring plus the word "now" for current, and a hollow node with the
 * word "not yet" for pending. A step with no time is pending — the timestamp is
 * not invented (docs/04 §1.2 P2).
 */
export function ProgressStepper({ steps }: { steps: readonly TrackStep[] }) {
  return (
    <ol className="relative flex flex-col gap-3 pl-1">
      <span aria-hidden="true" className="absolute top-3 bottom-3 left-[9px] w-px bg-subtle" />

      {steps.map((step) => (
        <li key={step.status} className="relative flex gap-3 pl-7">
          <Node state={step.state} />

          <div className="flex min-w-0 flex-1 flex-col">
            <p
              className={cn(
                'text-sm font-semibold',
                step.state === 'pending' ? 'text-muted' : 'text-primary',
              )}
            >
              {step.label}
            </p>
            <p className="text-xs text-secondary">
              {step.at ? (
                <>
                  <time dateTime={step.at} title={formatAbsolute(step.at)} className="tabular">
                    {formatClock(step.at)}
                  </time>
                  <span className="text-muted"> · {stateWord(step.state)}</span>
                </>
              ) : (
                stateWord(step.state)
              )}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function Node({ state }: { state: TrackStep['state'] }) {
  if (state === 'done') {
    return (
      <span
        aria-hidden="true"
        className="absolute top-0 left-0 flex size-[19px] items-center justify-center rounded-pill bg-success text-on-solid"
      >
        <Check className="size-3" />
      </span>
    );
  }
  if (state === 'current') {
    return (
      <span
        aria-hidden="true"
        className="absolute top-0.5 left-0.5 size-4 rounded-pill border-2 border-accent"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="absolute top-0.5 left-0.5 size-4 rounded-pill border-2 border-default"
    />
  );
}

/** A word for every state, so urgency of progress is never colour-only. */
function stateWord(state: TrackStep['state']): string {
  if (state === 'done') return 'done';
  if (state === 'current') return 'now';
  return 'not yet';
}

/** The heading block above the stepper. */
export function ProgressHeader() {
  return (
    <div className="flex flex-col gap-1">
      <h2 className="text-base font-semibold text-primary">{TRACK_COPY.progressTitle}</h2>
      <p className="max-w-[72ch] text-xs text-secondary">{TRACK_COPY.progressLead}</p>
    </div>
  );
}
