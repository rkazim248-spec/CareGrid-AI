'use client';

/**
 * ============================================================================
 * The AI triage panel — brief §13, §14, §15, §16, §17
 * ============================================================================
 *
 * What a citizen sees after pressing "Analyse with AI", and what they can do
 * about it.
 *
 * ---------------------------------------------------------------------------
 * THE FIVE RULES THIS COMPONENT ENFORCES
 * ---------------------------------------------------------------------------
 * Each is a docs/04 or brief requirement, and each is a place where a
 * reasonable-looking implementation gets it wrong:
 *
 *  1. **The AI result is EDITABLE and the citizen can override every field.**
 *     brief §15: "Never lock the AI-generated result." Nothing here is
 *     `readOnly`. A citizen who knows there are two people and the AI said
 *     `other` must be able to say so, and must not have to fight a control to
 *     do it.
 *  2. **The result is labelled as the AI's, in every view of it.** docs/04 §2.12
 *     and brief §14. Not a grey badge in the corner — the category row, the
 *     urgency row, the summary and the resources all say "AI assessment". A
 *     citizen who cannot tell a machine's guess from a verified fact will
 *     eventually trust the wrong one.
 *  3. **Confidence is never a bare percentage.** brief §14. A percentage alone
 *     reads as a measurement; `confidenceLabel` appends the words "AI
 *     assessment" and the word "estimate", and the low band refuses to show a
 *     number at all.
 *  4. **Urgency is never colour alone.** brief §16 and docs/04 §7. Every band
 *     renders the `URGENCY_META` icon, an UPPERCASE text label, and a text
 *     qualifier. `docs/04 §2.11` contrast is carried by the badge classes, and
 *     the label means the panel is readable with no colour perception at all.
 *  5. **The AI never blocks the report.** brief §19. When analysis fails, this
 *     renders the manual form and says so in one sentence. There is no path in
 *     which a failed analysis prevents a submission.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PROGRESS STEPS ARE NOT A FAKE PERCENTAGE
 * ---------------------------------------------------------------------------
 * brief §17 asks for staged progress and forbids a fake percentage. The steps
 * are therefore REAL states, driven by an elapsed timer against a real timeout,
 * and the two that cannot be observed from the client (the request, the
 * validation) are marked complete when the response arrives rather than
 * pretending to progress. Nothing here invents motion.
 */

import * as React from 'react';

import {
  Alert,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ProgressIndeterminate,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@/components/ui';
import { CATEGORY_META, URGENCY_META } from '@/config';
import { AI_TRIAGE_COPY } from '@/features/reporting/ai-triage-copy';
import type { AiTriageResponse, AiTriageStep } from '@/features/reporting/ai-triage-types';
import type { IncidentCategory, SafetyFlag, Urgency } from '@/types';

/**
 * The resources the panel renders.
 *
 * The endpoint's response schema does not currently carry `requiredResources`,
 * because `validators/ai.ts` models the probe response and adding a nested
 * resource array to it would mean restating the AI schema's shape in two places —
 * the drift `services/ai/schema.ts` exists to prevent. The field is read with a
 * default so the panel renders correctly against a response that omits it, and
 * the Phase 5 create pipeline is where the full record arrives.
 *
 * Stated as a narrowing of the wire type rather than a cast at the use site, so
 * when `validators/ai.ts` gains the field the two converge and this line is the
 * one that gets deleted.
 */
type PanelResources = AiTriageResponse & {
  readonly requiredResources?: readonly {
    readonly resourceId: string;
    readonly name: string;
    readonly source: 'reporter' | 'ai';
  }[];
};

/* ========================================================================== */
/* Urgency — icon + label + qualifier, never colour alone                       */
/* ========================================================================== */

/**
 * The urgency row.
 *
 * `docs/04 §2.6` owns this decision and the `URGENCY_META` table already carries
 * the icon, the label, the four colours, the marker shape and the `ariaTemplate`.
 * This component adds no per-value branching of its own, so a new urgency value
 * cannot render inconsistently between this panel and the map.
 */
function UrgencyBadge({ urgency }: { urgency: Urgency }) {
  const meta = URGENCY_META[urgency];
  const Icon = meta.icon;
  return (
    <Badge
      className={`${meta.bgClass} ${meta.textClass} ${meta.borderClass} gap-1.5 uppercase`}
      // The aria-label carries the SLA, which the visible text does not. A
      // screen-reader user gets the response target; a sighted user gets it on the
      // dispatcher panel. Neither has to ask.
      aria-label={meta.ariaTemplate(meta.slaMinutes)}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {meta.label}
    </Badge>
  );
}

/* ========================================================================== */
/* The band: the visible second channel                                        */
/* ========================================================================== */

function ConfidenceBand({ confidence, needsReview }: { confidence: number | null; needsReview: boolean }) {
  if (confidence === null) {
    return (
      <p className="text-sm text-secondary">{AI_TRIAGE_COPY.confidenceUnavailable}</p>
    );
  }

  const percent = Math.round(confidence * 100);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-primary">{AI_TRIAGE_COPY.confidenceLabel(percent)}</span>
      {needsReview ? (
        <Badge variant="default" size="sm" className="border-warning bg-warning-muted text-warning-fg-muted">{AI_TRIAGE_COPY.needsReviewBadge}</Badge>
      ) : null}
    </div>
  );
}

/* ========================================================================== */
/* Loading                                                                      */
/* ========================================================================== */

/**
 * The analysis state, brief §17.
 *
 * The steps are driven by a timer, and `serverStep` marks the two phases the
 * browser genuinely cannot observe. Both are advanced on ELAPSED TIME, not on
 * invented progress, and the final step is only shown once the response has
 * actually been validated — so the list always describes something true.
 */
function AnalysisProgress({ step }: { step: AiTriageStep }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-3">
      <ProgressIndeterminate label={AI_TRIAGE_COPY.analysing} />
      <ul className="flex flex-col gap-1.5">
        {AI_TRIAGE_COPY.steps.map((text, index) => {
          const complete = index < step;
          return (
            <li
              key={text}
              className={`flex items-center gap-2 text-sm ${complete ? 'text-primary' : 'text-muted'}`}
            >
              <span aria-hidden="true" className="w-4 text-center">
                {complete ? '✓' : '◌'}
              </span>
              {text}
              {complete ? <span className="sr-only">{AI_TRIAGE_COPY.stepDone}</span> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ========================================================================== */
/* The editable result                                                          */
/* ========================================================================== */

/**
 * What the citizen can change.
 *
 * A local copy, seeded from the response, and `onChange` on every control. The
 * citizen's edits are the source of truth from the first keystroke — the AI
 * result is only ever the INITIAL value, never the value the form submits if the
 * citizen has touched it. That is what "never lock the result" means in practice,
 * and it is why this is controlled state rather than a read-only display.
 */
export type EditableTriage = {
  category: IncidentCategory;
  urgency: Urgency;
  summary: string;
  peopleAffected: number | null;
  requiredResources: string[];
};

function toEditable(response: AiTriageResponse): EditableTriage {
  return {
    // `other` and `low` are the documented floors, so a partial response still
    // produces a complete, valid selection rather than an empty control.
    category: (response.category as IncidentCategory | null) ?? 'other',
    urgency: (response.urgency as Urgency | null) ?? 'low',
    summary: response.summary ?? AI_TRIAGE_COPY.summaryFallback,
    // NEVER a number the AI produced. docs/09 §1.2 rule 4 and R4: a casualty
    // count is a STATED figure or it is null, and the only person who can state
    // one is the reporter. Seeding this from the model would be a fabricated
    // casualty count in the citizen's own report.
    peopleAffected: null,
    requiredResources: [],
  };
}

/* ========================================================================== */
/* The panel                                                                    */
/* ========================================================================== */

export type AiTriagePanelProps = {
  readonly response: AiTriageResponse | null;
  readonly step: AiTriageStep;
  readonly error: string | null;
  readonly onRetry: () => void;
  readonly onApply: (value: EditableTriage) => void;
  readonly onDismiss: () => void;
  /** `true` when the account has no live AI key, so the button is not offered. */
  readonly providerAvailable: boolean;
};

export function AiTriagePanel({
  response,
  step,
  error,
  onRetry,
  onApply,
  onDismiss,
  providerAvailable,
}: AiTriagePanelProps) {
  const [editable, setEditable] = React.useState<EditableTriage | null>(null);

  // Re-seeded when a NEW response arrives (a retry), never on every render — an
  // unconditional effect would discard the citizen's edits the moment they
  // touched a control, which is the exact bug brief §15 warns about.
  const responseKey = response === null ? null : `${response.promptVersion}:${response.confidence ?? 'x'}`;
  React.useEffect(() => {
    setEditable(response === null ? null : toEditable(response));
  }, [responseKey, response]);

  /* --- failure: the manual fallback, never a dead end -------------------- */
  if (error !== null) {
    return (
      <Card className="border-warning">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            {AI_TRIAGE_COPY.unavailableTitle}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Alert tone="warning">
            <AlertIcon tone="warning" />
            <div className="flex min-w-0 flex-col gap-1">
              <AlertTitle>{AI_TRIAGE_COPY.unavailableTitle}</AlertTitle>
              <AlertDescription>{AI_TRIAGE_COPY.unavailableBody}</AlertDescription>
            </div>
          </Alert>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" onClick={onRetry}>
              {AI_TRIAGE_COPY.retry}
            </Button>
            <Button type="button" variant="ghost" onClick={onDismiss}>
              {AI_TRIAGE_COPY.continueManually}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  /* --- no AI configured at all: say so, do not offer a dead button ------- */
  if (!providerAvailable && response === null && step === 0) {
    return (
      <Alert tone="info">
        <AlertIcon tone="info" />
        <div className="flex min-w-0 flex-col gap-1">
          <AlertTitle>{AI_TRIAGE_COPY.notConfiguredTitle}</AlertTitle>
          <AlertDescription>{AI_TRIAGE_COPY.notConfiguredBody}</AlertDescription>
        </div>
      </Alert>
    );
  }

  /* --- in flight ------------------------------------------------------- */
  if (response === null) return <AnalysisProgress step={step} />;
  if (editable === null) return null;

  const isFallback = response.source !== 'ai';
  const flags = response.safetyFlags as readonly SafetyFlag[];
  const resources: readonly { readonly resourceId: string; readonly name: string; readonly source: 'reporter' | 'ai' }[] =
    (response as PanelResources).requiredResources ?? [];

  return (
    <Card className={response.needsReview ? 'border-warning' : 'border-default'}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {AI_TRIAGE_COPY.title}
          {/* A FALLBACK is not a weaker AI answer, it is a different thing, and
              it is labelled as such. A citizen who reads "AI assessment: low,
              55% confident" when the truth is "keyword matching, 55% confident"
              has been told something false. */}
          {isFallback ? (
            <Badge variant="default" size="sm" className="border-warning bg-warning-muted text-warning-fg-muted">{AI_TRIAGE_COPY.fallbackBadge}</Badge>
          ) : null}
          {response.simulated ? (
            <Badge
              variant="default"
              size="sm"
              className="border-warning bg-warning-muted text-warning-fg-muted"
            >
              {AI_TRIAGE_COPY.simulatedBadge}
            </Badge>
          ) : null}
        </CardTitle>
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        {/* --- the provenance notice ------------------------------------- */}
        <p className="text-sm text-secondary">{AI_TRIAGE_COPY.disclaimer}</p>

        {/* --- category: EDITABLE ---------------------------------------- */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="ai-category" className="text-xs font-medium text-secondary">
            {AI_TRIAGE_COPY.categoryLabel}
          </label>
          <Select
            value={editable.category}
            onValueChange={(value) =>
              setEditable({ ...editable, category: value as IncidentCategory })
            }
          >
            <SelectTrigger id="ai-category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(CATEGORY_META) as IncidentCategory[]).map((category) => (
                <SelectItem key={category} value={category}>
                  {CATEGORY_META[category].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted">{AI_TRIAGE_COPY.categoryHelp}</p>
        </div>

        {/* --- urgency: EDITABLE ----------------------------------------- */}
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-secondary">{AI_TRIAGE_COPY.urgencyLabel}</span>
          <div className="flex flex-wrap items-center gap-2">
            <UrgencyBadge urgency={editable.urgency} />
            <Select
              value={editable.urgency}
              onValueChange={(value) => setEditable({ ...editable, urgency: value as Urgency })}
            >
              <SelectTrigger aria-label={AI_TRIAGE_COPY.urgencyLabel} className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(URGENCY_META) as Urgency[]).map((urgency) => (
                  <SelectItem key={urgency} value={urgency}>
                    {URGENCY_META[urgency].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-xs text-muted">
              {AI_TRIAGE_COPY.slaHint(URGENCY_META[editable.urgency].slaMinutes)}
            </span>
          </div>
        </div>

        {/* --- summary: EDITABLE ----------------------------------------- */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="ai-summary" className="text-xs font-medium text-secondary">
            {AI_TRIAGE_COPY.summaryLabel}
          </label>
          <Textarea
            id="ai-summary"
            value={editable.summary}
            maxLength={240}
            rows={3}
            onChange={(event) => setEditable({ ...editable, summary: event.target.value })}
          />
          <p className="text-xs text-muted">{AI_TRIAGE_COPY.summaryHelp}</p>
        </div>

        {/* --- people affected: NEVER pre-filled ------------------------ */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="ai-people" className="text-xs font-medium text-secondary">
            {AI_TRIAGE_COPY.peopleLabel}
          </label>
          <input
            id="ai-people"
            type="number"
            min={0}
            max={100000}
            inputMode="numeric"
            value={editable.peopleAffected ?? ''}
            onChange={(event) => {
              const raw = event.target.value;
              setEditable({
                ...editable,
                // Empty string is `null`, not `0`. A blank field means "I do not
                // know" and writing a 0 there would be a claim.
                peopleAffected: raw === '' ? null : Math.max(0, Number(raw)),
              });
            }}
            className="border-default rounded-md border bg-surface px-3 py-2 text-sm"
          />
          <p className="text-xs text-muted">{AI_TRIAGE_COPY.peopleHelp}</p>
        </div>

        {/* --- required resources: shown, editable, never auto-requested -- */}
        {resources.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-secondary">
              {AI_TRIAGE_COPY.resourcesLabel}
            </span>
            <ul className="flex flex-col gap-1">
              {resources.map((resource) => (
                <li key={resource.resourceId} className="text-sm text-primary">
                  {resource.name}
                  <span className="text-muted">
                    {' — '}
                    {resource.source === 'reporter'
                      ? AI_TRIAGE_COPY.resourceFromReporter
                      : AI_TRIAGE_COPY.resourceFromAi}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted">{AI_TRIAGE_COPY.resourcesHelp}</p>
          </div>
        ) : null}

        {/* --- safety flags: shown with their config-system wording ------- */}
        {flags.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-secondary">
              {AI_TRIAGE_COPY.flagsLabel}
            </span>
            <ul className="flex flex-wrap gap-1.5">
              {flags.map((flag) => (
                <li key={flag}>
                  <Badge
                    variant="default"
                    size="sm"
                    // A real safety flag and "we are unsure" are not the same
                    // severity, and a reader must be able to tell them apart
                    // without reading the label.
                    className={
                      flag === 'low_confidence'
                        ? 'border-warning bg-warning-muted text-warning-fg-muted'
                        : 'border-danger bg-danger-muted text-danger'
                    }
                  >
                    {AI_TRIAGE_COPY.flagLabels[flag] ?? flag}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* --- what the AI could not determine --------------------------- */}
        {response.unknownFields.length > 0 ? (
          <p className="text-sm text-secondary">
            {AI_TRIAGE_COPY.unknownFields(response.unknownFields.join(', '))}
          </p>
        ) : null}

        {/* --- dropped media: honest, not silent ------------------------- */}
        {response.mediaDropped.length > 0 ? (
          <Alert tone="warning">
            <AlertIcon tone="warning" />
            <AlertDescription>
              {AI_TRIAGE_COPY.mediaDropped(response.mediaDropped.length)}
            </AlertDescription>
          </Alert>
        ) : null}

        {/* --- confidence ----------------------------------------------- */}
        <ConfidenceBand confidence={response.confidence} needsReview={response.needsReview} />

        {/* --- the two actions, and Edit is not secondary by accident --- */}
        <div className="flex flex-wrap gap-2 border-t border-subtle pt-4">
          <Button type="button" variant="primary" onClick={() => onApply(editable)}>
            {AI_TRIAGE_COPY.confirm}
          </Button>
          <Button type="button" variant="secondary" onClick={onRetry}>
            {AI_TRIAGE_COPY.reanalyse}
          </Button>
          <Button type="button" variant="ghost" onClick={onDismiss}>
            {AI_TRIAGE_COPY.dismiss}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
