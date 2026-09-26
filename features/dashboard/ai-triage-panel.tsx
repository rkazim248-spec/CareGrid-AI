'use client';

import * as React from 'react';
import { Bot, Clock, Info } from 'lucide-react';

import {
  Alert,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui';
import { ConfidenceBadge, ConfidenceBar, UrgencyBadge } from '@/components/domain';
import { CATEGORY_META, SAFETY_FLAG_META, URGENCY_META } from '@/config';
import { formatConfidence, formatDuration } from '@/lib/format';
import type { AiAnalysis, Incident } from '@/types';

/**
 * AiTriagePanel — docs/04 §13.9, §14.2, §15.2.
 *
 * The header is literally "AI triage — advisory" and the panel carries a
 * permanent `neutral` Alert saying the same thing in a sentence. Three rules
 * make the panel honest rather than decorative:
 *
 *  1. `fallbackUsed` is stated, not hidden. When automated triage was
 *     unavailable the panel says so in a `warning` tone instead of showing a
 *     confident-looking number.
 *  2. The urgency is rendered as an `UrgencyBadge` WITH its source, so a
 *     reader can tell an AI estimate from a person’s decision (docs/04 §7.2).
 *  3. Nothing here writes anything. The panel describes what a reviewer must
 *     check before an incident is verified.
 *
 * PHASE 1 DATA NOTE: `MOCK_INCIDENTS` carries the triage FIELDS
 * (`aiConfidence`, `aiNeedsReview`, `triageSource`, `urgencySource`,
 * `safetyFlags`) but no `AiAnalysis` record. `buildDemoTriage` composes the
 * panel's view from those real fields plus demo-only run metadata, and every
 * run metric is labelled as demo data. From Phase 4 the server sends
 * `data.ai` and only `buildDemoTriage` is deleted.
 */

const DEMO_MODEL = 'gemini-2.5-flash';
const DEMO_PROMPT_VERSION = 'triage-v3';
const DEMO_LATENCY_MS = 3_100;

export function buildDemoTriage(incident: Incident): AiAnalysis {
  return {
    runId: `run_${incident.incidentId.slice(0, 8)}`,
    model: DEMO_MODEL,
    promptVersion: DEMO_PROMPT_VERSION,
    confidence: incident.aiConfidence,
    outcome: incident.triageSource === 'fallback' ? 'timeout' : 'success',
    fallbackUsed: incident.triageSource === 'fallback',
    latencyMs: DEMO_LATENCY_MS,
    safetyFlags: incident.safetyFlags,
    explanation: incident.aiNeedsReview
      ? 'The model was not confident about this report. Read the original text before you act.'
      : 'No safety rule raised the urgency above the model estimate.',
  };
}

export function AiTriagePanel({
  incident,
  className,
}: {
  incident: Incident;
  className?: string;
}) {
  const analysis = buildDemoTriage(incident);
  const urgencyMeta = URGENCY_META[incident.urgency];
  const raisedBy = incident.safetyFlags.find(
    (flag) => SAFETY_FLAG_META[flag].tone === 'danger',
  );

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Bot className="size-4 text-muted" aria-hidden="true" />
          AI triage — advisory
        </CardTitle>
        <p className="text-xs text-muted">Demo data. A person reviews every field.</p>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <ConfidenceBadge
            confidence={incident.aiConfidence}
            needsReview={incident.aiNeedsReview}
          />
          <ConfidenceBar confidence={incident.aiConfidence} className="max-w-32 flex-1" />
        </div>

        {analysis.fallbackUsed ? (
          <Alert tone="warning">
            <AlertIcon tone="warning" />
            <div>
              <AlertTitle>Fallback triage</AlertTitle>
              <AlertDescription>
                Automated triage was unavailable, so this report is waiting for a person.
              </AlertDescription>
            </div>
          </Alert>
        ) : null}

        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
          <Row label="Category">
            <Badge variant="outline" size="sm">
              {CATEGORY_META[incident.category].label}
            </Badge>
          </Row>
          <Row label="Urgency estimate">
            <UrgencyBadge urgency={incident.urgency} source={incident.urgencySource} size="sm" />
          </Row>
          <Row label="Confidence">
            <span className="tabular text-secondary">{formatConfidence(incident.aiConfidence)}</span>
          </Row>
          <Row label="Fallback used">
            <Badge
              variant="outline"
              size="sm"
              className={
                analysis.fallbackUsed ? 'border-warning text-warning' : 'border-success text-success'
              }
            >
              {analysis.fallbackUsed ? 'Yes' : 'No'}
            </Badge>
            <span className="text-secondary">
              {analysis.fallbackUsed ? 'Fallback triage ran' : 'No fallback needed'}
            </span>
          </Row>
          <Row label="Model">
            <span className="font-mono text-secondary">{analysis.model}</span>
          </Row>
          <Row label="Prompt version">
            <span className="font-mono text-secondary">{analysis.promptVersion}</span>
          </Row>
          <Row label="Run time">
            <span className="flex items-center gap-1.5 tabular text-secondary">
              <Clock className="size-3.5" aria-hidden="true" />
              {formatDuration(Math.round(analysis.latencyMs / 100) * 100)}
            </span>
          </Row>
          <Row label="Response target">
            <span className="tabular text-secondary">{urgencyMeta.slaMinutes} min</span>
          </Row>
        </dl>

        {raisedBy ? (
          <p className="text-xs text-secondary">
            <span className="uppercase-label mr-1.5 text-muted">Why</span>
            Urgency was set to {urgencyMeta.label} by the safety rule for “
            {SAFETY_FLAG_META[raisedBy].label}”.
          </p>
        ) : null}

        <Alert tone="neutral">
          <AlertIcon tone="neutral" />
          <div>
            <AlertTitle className="flex items-center gap-1.5">
              <Info className="size-3.5" aria-hidden="true" />
              Read this before acting
            </AlertTitle>
            <AlertDescription>
              This is an estimate produced from the report text and media. A person reviews every
              field before an incident is verified.
            </AlertDescription>
          </div>
        </Alert>
      </CardContent>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="uppercase-label text-muted">{label}</dt>
      <dd className="flex flex-wrap items-center gap-1.5 text-sm">{children}</dd>
    </div>
  );
}
