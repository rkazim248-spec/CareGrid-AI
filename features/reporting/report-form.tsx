'use client';

import * as React from 'react';

import {
  Alert,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardHeader,
  ProgressIndeterminate,
  Textarea,
} from '@/components/ui';
import { REPORT_LIMITS } from '@/config';
import { REPORT_COPY } from '@/features/reporting/report-copy';
import { CategorySelector } from '@/features/reporting/category-selector';
import { EvidenceSlots } from '@/features/reporting/evidence-slot';
import { LocationPanel } from '@/features/reporting/location-panel';
import { ReviewPanel } from '@/features/reporting/review-panel';
import { VoiceRecorder } from '@/features/reporting/voice-recorder';
import {
  EMPTY_DRAFT,
  canSubmit,
  type EvidenceItem,
  type ReportDraft,
  type ReportLocation,
  type LocationMethod,
} from '@/features/reporting/report-types';
import type { IncidentCategory } from '@/types';

/**
 * The report form — docs/04 §13.2.
 *
 * Mobile: one column with a STICKY bottom action bar. The bar sits 64px above
 * the viewport bottom because the responder bottom nav owns that band
 * (`BottomNav` is `min-h-16` and `fixed` below `md`); the bar carries
 * `pb-[env(safe-area-inset-bottom)]` so it clears the home indicator, and the
 * final section carries bottom padding so nothing is ever hidden behind it.
 *
 * Desktop: `lg:grid-cols-[minmax(0,1fr)_360px]` — the form left, an explainer
 * right. The explainer is NOT a second column on mobile: a distressed person
 * scrolling one-handed should not have to read it before the fields.
 */
const SUBMIT_LATENCY_MS = 1000;

export function ReportForm({ onSubmitted }: { onSubmitted: () => void }) {
  const [draft, setDraft] = React.useState<ReportDraft>(EMPTY_DRAFT);
  const [submitting, setSubmitting] = React.useState(false);
  const reasonRef = React.useRef<HTMLParagraphElement | null>(null);
  const counter = React.useRef(0);
  const reasonId = 'report-submit-reason';

  const ready = canSubmit(draft, REPORT_LIMITS.textMinChars);

  const setText = React.useCallback((text: string) => {
    setDraft((current) => ({ ...current, text }));
  }, []);

  const addEvidence = React.useCallback(() => {
    counter.current += 1;
    const item: EvidenceItem = {
      id: `evidence-${counter.current}`,
      name: `photo-${counter.current}.jpg`,
      progress: 0,
    };
    setDraft((current) =>
      current.evidence.length >= REPORT_LIMITS.maxImages
        ? current
        : { ...current, evidence: [...current.evidence, item] },
    );
  }, []);

  const removeEvidence = React.useCallback((id: string) => {
    setDraft((current) => ({
      ...current,
      evidence: current.evidence.filter((item) => item.id !== id),
    }));
  }, []);

  const setProgress = React.useCallback((id: string, progress: number) => {
    setDraft((current) => ({
      ...current,
      evidence: current.evidence.map((item) => (item.id === id ? { ...item, progress } : item)),
    }));
  }, []);

  const setLocation = React.useCallback((location: ReportLocation, method: LocationMethod) => {
    setDraft((current) => ({ ...current, location, locationMethod: method }));
  }, []);

  const setCategory = React.useCallback((category: IncidentCategory | null) => {    setDraft((current) => ({ ...current, category }));
  }, []);

  const explainDisabled = React.useCallback(() => {
    reasonRef.current?.focus();
  }, []);

  const handleSubmit = React.useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!ready) {
        explainDisabled();
        return;
      }
      setSubmitting(true);
      // No request is made in Phase 1. See report-copy.ts phaseNotice.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, SUBMIT_LATENCY_MS);
      });
      setSubmitting(false);
      onSubmitted();
    },
    [ready, explainDisabled, onSubmitted],
  );

  return (
    <form noValidate onSubmit={handleSubmit} className="flex flex-col gap-6">
      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-8">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <h2 className="text-lg leading-tight font-semibold text-primary">
                {REPORT_COPY.whatIsHappeningTitle}
              </h2>
            </CardHeader>
            <CardContent>
              <Textarea
                id="report-text"
                label="Describe what is happening"
                helperText={REPORT_COPY.whatIsHappeningHelper}
                placeholder={REPORT_COPY.whatIsHappeningPlaceholder}
                rows={6}
                maxLength={REPORT_LIMITS.textMaxChars}
                showCount
                value={draft.text}
                onChange={(event) => setText(event.target.value)}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <h2 className="text-lg leading-tight font-semibold text-primary">
                {REPORT_COPY.photosTitle}
              </h2>
              <p className="text-sm text-secondary">{REPORT_COPY.photosLead}</p>
            </CardHeader>
            <CardContent>
              <EvidenceSlots
                items={draft.evidence}
                onAdd={addEvidence}
                onRemove={removeEvidence}
                onProgress={setProgress}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <h2 className="text-lg leading-tight font-semibold text-primary">
                {REPORT_COPY.voiceTitle}
              </h2>
              <p className="text-sm text-secondary">{REPORT_COPY.voiceLead}</p>
            </CardHeader>
            <CardContent>
              <VoiceRecorder />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <h2 className="text-lg leading-tight font-semibold text-primary">
                {REPORT_COPY.locationTitle}
              </h2>
            </CardHeader>
            <CardContent>
              <LocationPanel
                location={draft.location}
                method={draft.locationMethod}
                onChange={setLocation}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <h2 className="text-lg leading-tight font-semibold text-primary">
                {REPORT_COPY.categoryTitle}
              </h2>
            </CardHeader>
            <CardContent>
              <CategorySelector value={draft.category} onChange={setCategory} />
            </CardContent>
          </Card>

          <div className="pb-4 lg:pb-0">
            <ReviewPanel draft={draft} />
          </div>
        </div>

        <aside className="flex flex-col gap-4 lg:sticky lg:top-20">
          <Card>
            <CardHeader>
              <h2 className="text-base font-semibold text-primary">{REPORT_COPY.nextTitle}</h2>
            </CardHeader>
            <CardContent>
              <p className="max-w-[52ch] text-sm text-secondary">{REPORT_COPY.nextBody}</p>
            </CardContent>
          </Card>

          <Alert tone="info">
            <AlertIcon tone="info" />
            <div className="flex min-w-0 flex-col gap-1">
              <AlertTitle>{REPORT_COPY.privacyAlertTitle}</AlertTitle>
              <AlertDescription>{REPORT_COPY.privacyAlertBody}</AlertDescription>
            </div>
          </Alert>
        </aside>
      </div>

      <div className="sticky bottom-16 z-20 -mx-4 border-t border-subtle bg-surface px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] lg:-mx-8 lg:bottom-0 lg:px-8">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-end">
          {submitting ? (
            <div role="status" className="flex flex-col gap-1.5 lg:flex-1">
              <ProgressIndeterminate label={REPORT_COPY.submitting} />
              <p className="text-xs text-secondary">{REPORT_COPY.submitting}</p>
            </div>
          ) : (
            <p className="hidden text-xs text-secondary lg:flex-1" />
          )}

          <div className="flex flex-col gap-2">
            <Button
              type="submit"
              variant="primary"
              size="xl"
              className="w-full lg:w-auto"
              loading={submitting}
              // FR-017 (docs/04 §10.4): not `disabled`. The control stays in
              // the tab order, and activating it moves focus to the reason
              // instead of doing nothing silently. `handleSubmit` does exactly
              // that, for pointer and keyboard alike.
              aria-disabled={ready ? undefined : true}
              aria-describedby={reasonId}
            >
              {REPORT_COPY.submitLabel}
            </Button>

            <p
              ref={reasonRef}
              id={reasonId}
              tabIndex={-1}
              className="text-xs text-warning focus:outline-none"
            >
              {ready ? ' ' : REPORT_COPY.submitDisabledReason}
            </p>
          </div>
        </div>
      </div>
    </form>
  );
}
