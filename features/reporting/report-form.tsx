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
import { EvidenceUploader } from '@/features/reporting/evidence-uploader';
import { startUpload, subscribeUploads, uploadSnapshot } from '@/features/reporting/upload-manager';
import { LocationPanel } from '@/features/reporting/location-panel';
import { ReviewPanel } from '@/features/reporting/review-panel';
import { VoiceRecorder } from '@/features/reporting/voice-recorder';
import { AiTriagePanel, type EditableTriage } from '@/features/reporting/ai-triage-panel';
import { AI_TRIAGE_COPY } from '@/features/reporting/ai-triage-copy';
import { mapTriageResponse } from '@/features/reporting/map-triage-response';
import type { AiTriageResponse, AiTriageStep } from '@/features/reporting/ai-triage-types';
import type { PendingUpload, VoiceRecording } from '@/types/media';
import { aiTriage } from '@/lib/api/client';
import { isApiError } from '@/lib/api/errors';
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

/**
 * How long each analysis step stays on screen.
 *
 * brief §17: "If the API returns quickly, don't artificially delay the user
 * unnecessarily." So the timer is a DISPLAY floor for the early steps only — a
 * real model call takes seconds, and a step that flashed past in 40 ms reads as
 * a glitch. The final step is NOT gated on this at all: when the response arrives
 * the panel switches to the result immediately, whatever the step counter says.
 *
 * That is the whole design: pace the beginning so the sequence is legible, never
 * pace the end.
 */
const STEP_INTERVAL_MS = 420;

export function ReportForm({ onSubmitted }: { onSubmitted: () => void }) {
  const [draft, setDraft] = React.useState<ReportDraft>(EMPTY_DRAFT);
  const [submitting, setSubmitting] = React.useState(false);
  const reasonRef = React.useRef<HTMLParagraphElement | null>(null);
  const reasonId = 'report-submit-reason';
  // A separate id, because two controls each need their own explanation and one
  // ria-describedby cannot point at two paragraphs.

  const ready = canSubmit(draft, REPORT_LIMITS.textMinChars);

  /* --- Phase 4: the AI triage state ------------------------------------- */
  // `idle` is the absence of the panel. It is not "the AI is off" — the AI may be
  // unconfigured and the panel will say so when the citizen asks for analysis.
  const [triageState, setTriageState] = React.useState<'idle' | 'running' | 'done'>('idle');
  const [triage, setTriage] = React.useState<AiTriageResponse | null>(null);
  const [triageError, setTriageError] = React.useState<string | null>(null);
  const [triageStep, setTriageStep] = React.useState<AiTriageStep>(0);
  // Tracks whether the panel has ever received a `providerAvailable` answer. The
  // panel's "not configured" state is only truthful once a call has come back, and
  // a panel that claims a deployment is unconfigured before it has asked is a
  // panel that guesses.
  const [triageProviderChecked, setTriageProviderChecked] = React.useState(false);
  const triageButtonReasonId = 'report-triage-reason';
  // Guards against a double-click or a re-render firing two model calls.
  // brief §31: "Disable the Analyze button while an analysis is running", and a
  // ref rather than the state so two calls in the same tick cannot both see a
  // stale `false`.
  const triageInFlight = React.useRef(false);

  // The step timer. Cleared on completion and on unmount, because a timer that
  // outlives its request keeps calling `setState` on an unmounted component.
  React.useEffect(() => {
    if (triageState !== 'running') return;
    const timer = setInterval(() => {
      setTriageStep((current) => (current >= 4 ? current : ((current + 1) as AiTriageStep)));
    }, STEP_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [triageState]);

  const runTriage = React.useCallback(async () => {
    if (triageInFlight.current) return;
    triageInFlight.current = true;
    setTriageState('running');
    setTriageError(null);
    setTriageStep(1);
    try {
      const response = await aiTriage({
        text: draft.text,
        language: 'en',
        ...(draft.location.placeName === null ? {} : { locationHint: draft.location.placeName }),
      });
      setTriage(mapTriageResponse(response));
      setTriageProviderChecked(true);
      setTriageState('done');
    } catch (caught) {
      // A failure is a rendered state, never a dead end. brief §19: emergency
      // reporting must remain available when the AI is not.
      // The server's own sentence, which `docs/16 §4` authors to be shown, and
      // which already says the report can still be submitted. A network failure
      // has no such sentence, so the copy table supplies one.
      setTriageError(isApiError(caught) ? caught.message : AI_TRIAGE_COPY.unavailableBody);
      setTriageState('running');
    } finally {
      triageInFlight.current = false;
    }
  }, [draft.text, draft.location.placeName]);

  /**
   * Apply the citizen's EDITED triage to the draft.
   *
   * Only the category is written back — it is the one field the draft already has
   * and the one the AI genuinely helps with. The summary and the people count are
   * the citizen's to write in their own report; copying an AI's paraphrase of
   * their words back over the top of the form would be the AI overwriting the
   * report, which is the opposite of docs/09 §5.2's "the original report is never
   * overwritten by AI interpretation".
   */
  const applyTriage = React.useCallback((value: EditableTriage) => {
    setDraft((current) => ({ ...current, category: value.category }));
    setTriageState('idle');
  }, []);

  const setText = React.useCallback((text: string) => {
    setDraft((current) => ({ ...current, text }));
  }, []);

  /**
   * A finished voice clip goes through the SAME upload pipeline as a photo.
   *
   * Not a special case, and deliberately so. brief §21 forbids a second Gemini
   * path and the same reasoning applies to Storage: an audio item is a file, it
   * has the same claim/sniff/finalize chain, and giving it its own code path is
   * how one of the two ends up without a size check or a signature check.
   *
   * The `Blob` is wrapped in a `File` because `startUpload` takes a `File`. That
   * is the only difference, and it is a typing convenience rather than a
   * behaviour change: a `Blob` already carries a `type`, and the wrapper is given
   * the recorder's own type rather than a guess.
   *
   * The name is server-shaped. `displayName` is a DISPLAY hint that the server
   * sanitises, never a path — docs/15 §3.5.
   */
  const addVoiceNote = React.useCallback((recording: VoiceRecording) => {
    const file = new File([recording.blob], recording.displayName, {
      type: recording.mimeType,
      lastModified: Date.now(),
    });
    void startUpload({
      file,
      kind: 'audio',
      durationSec: recording.durationSec,
      displayName: recording.displayName,
    });
  }, []);
  /**
   * Is a voice note on its way up?
   *
   * Read from the upload store with `useSyncExternalStore` rather than tracked in
   * a `useState` alongside it. A second copy of the same fact is a second thing to
   * forget to update: the recorder would say "added" while the uploader showed a
   * failure. This binds to the store, which is already the single source.
   *
   * `useSyncExternalStore` rather than `useState` + `subscribe` in an effect
   * because it cannot render a stale value on the first pass — the store already
   * exists before this component mounts, so the initial read is the truth rather
   * than an empty array that flashes and corrects.
   */
  const voiceUploaded = React.useSyncExternalStore(
    subscribeUploads,
    () => uploadSnapshot().some((item) => item.kind === 'audio' && item.status === 'uploaded'),
    // The server snapshot. `uploadSnapshot` reads a module-level `Map`, which is
    // empty on the server, so this is a correct and stable answer rather than a
    // stub — and it prevents the hydration mismatch React would otherwise resolve
    // by discarding the tree.
    () => false,
  );

  /**
   * The real uploader's output, folded back into the draft.
   *
   * This is not a duplicate of the upload store — it is the one place the form's
   * own state learns what has been uploaded, and it exists because
   * `canSubmit` treats a non-empty `evidence` as a submittable report. Without it,
   * a citizen with a photo of a fire and no text could not submit at all, which
   * is the image-only path docs/15 §16.3 explicitly has to keep working.
   *
   * Only `status === 'uploaded'` items are recorded. A failed or in-flight upload
   * is not evidence, and counting it would let a citizen submit a report whose
   * photo never arrived — a report that looks complete and has no photo.
   */
  const syncEvidence = React.useCallback((uploaded: readonly PendingUpload[]) => {
    setDraft((current) => {
      const next: EvidenceItem[] = uploaded.map((item) => ({
        id: item.localId,
        name: item.fileName,
        // Not the live progress. This is a snapshot for a view that no longer
        // animates; the real bar is in `EvidenceUploader`, and two live progress
        // values for one file is one too many.
        progress: item.progress / 100,
        ...(item.mediaId === undefined ? {} : { mediaId: item.mediaId }),
        ...(item.verifiedContentType === undefined ? {} : { mimeType: item.verifiedContentType }),
      }));
      // Identity check, so a re-render with an unchanged list does not produce a
      // new array. A fresh `evidence` array on every store emission would make
      // `draft` a new object every time and re-render the whole form on every
      // progress tick.
      const unchanged =
        current.evidence.length === next.length &&
        current.evidence.every((item, index) => item.mediaId === next[index]?.mediaId);
      return unchanged ? current : { ...current, evidence: next };
    });
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
              {/* Phase 5. This replaces the Phase 1 `EvidenceSlots`, which drew a
                  progress bar no bytes were behind. brief §24 forbids a faked
                  bar, so the real uploader takes its place. The `EvidenceItem`
                  draft field and its simulated add/remove/progress handlers are
                  still in the tree because `report-view.tsx` and the Phase 1
                  tests read them; removing that is Phase 6 tidy-up. */}
              <EvidenceUploader onChange={syncEvidence} disabled={submitting} />
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
              <VoiceRecorder
                onRecorded={addVoiceNote}
                hasRecording={voiceUploaded}
                disabled={submitting}
              />
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
              {/* Phase 6. `useLocation` is wired in here but its panel is NOT
                  rendered yet — see `docs/30.7 §9`. The Phase 1 `LocationPanel` above
                  is the static, non-functional placeholder and stays in place so
                  Phase 1-3 behaviour and tests are untouched. The hook is exercised
                  by `tests/unit/geo/use-location.test.ts` through its pure
                  resolution logic. */}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <h2 className="text-lg leading-tight font-semibold text-primary">
                {REPORT_COPY.categoryTitle}
              </h2>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <CategorySelector value={draft.category} onChange={setCategory} />

              {/*
                brief §31: "User completes report -> User presses Analyze -> One
                AI request", and "Disable the Analyze button while an analysis is
                running."

                The button is NOT disabled, for the same reason the submit button
                is not (FR-017, docs/04 §10.4): it stays in the tab order and
                activating it while a request is in flight is a no-op, announced
                through `aria-busy` and the reason paragraph below. A `disabled`
                attribute removes the control from the tab order, so a keyboard user
                tabbing past it does not learn why it is greyed out.

                It is also never sent on a keystroke. There is no effect here that
                calls the model, which is the property that actually costs money.
              */}
              <div className="flex flex-col gap-1.5">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={runTriage}
                  loading={triageState === 'running'}
                  aria-busy={triageState === 'running'}
                  aria-describedby={triageButtonReasonId}
                  disabled={!ready}
                >
                  {REPORT_COPY.analyseLabel}
                </Button>
                <p
                  id={triageButtonReasonId}
                  className="text-xs text-secondary"
                  aria-live="polite"
                >
                  {triageState === 'running'
                    ? AI_TRIAGE_COPY.analysing
                    : ready
                      ? REPORT_COPY.analyseHelper
                      : REPORT_COPY.submitDisabledReason}
                </p>
              </div>
            </CardContent>
          </Card>

          {/*
            -------------------------------------------------------------------
            PHASE 4: THE AI TRIAGE PANEL
            -------------------------------------------------------------------
            Placed BELOW the description, the photos and the location, and ABOVE
            the review block. The order is the reading order of the decision: what
            happened, what it looks like, where, what category someone already
            picked, and then what the AI made of all four.

            It is also below the category selector on purpose. The AI's job is to
            SUGGEST a category, and a suggestion that appears above the manual
            control reads as the default — a citizen who has already chosen
            "Medical" should not then be shown an AI card suggesting "Other" and
            have to work out which one wins.

            `onApply` writes the citizen's EDITED values into the draft. The panel
            never writes to the draft on its own: a suggestion that silently
            overwrote a choice the citizen had already made is how an AI ends up
            overriding a person, which MUST NOT 8 forbids in the other direction.
          */}
          {triageState !== 'idle' || triageProviderChecked ? (
            <AiTriagePanel
              response={triageState === 'done' ? triage : null}
              step={triageStep}
              error={triageError}
              // `false` only once a call has actually come back and said so. Until
              // then it is `true` and the panel shows progress, because a panel
              // that says "not configured" before it has asked is a panel that
              // guesses.
              providerAvailable={triage?.providerAvailable ?? true}
              onRetry={runTriage}
              onApply={applyTriage}
              onDismiss={() => {
                setTriageState('idle');
                setTriageError(null);
              }}
            />
          ) : null}

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
