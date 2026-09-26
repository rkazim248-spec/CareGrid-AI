/**
 * Urgency metadata — docs/04_UI_UX_DESIGN_SPECIFICATION.md §2.6, §7.1
 *
 * THE ONE place urgency becomes a visual decision. Icon + label + colour +
 * shape are all here so a component can never assemble an inconsistent set,
 * and so `UrgencyBadge` has no per-value branching of its own.
 *
 * These four colours are the one thing in the project that cannot be revisited
 * late (docs/30_DEVELOPMENT_PHASE_PLAN.md §4.8). Every value is contrast
 * verified in docs/04 §2.11. Do not "improve" them.
 */

import { Circle, CircleAlert, Siren, TriangleAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { MarkerShape, Urgency } from '@/types/enums';

export type UrgencyMeta = {
  readonly label: string;
  readonly icon: LucideIcon;
  /** Tailwind text token. Never a hex literal — the eslint rule forbids it. */
  readonly textClass: string;
  readonly bgClass: string;
  readonly borderClass: string;
  /** Second, non-colour channel for the map (docs/04 §11.1). */
  readonly shape: MarkerShape;
  /** Minutes. FR-026. Also the SLA denominator. */
  readonly slaMinutes: number;
  /** Sort weight. Lower sorts first in the queue (FR-071). */
  readonly rank: number;
  /** Full human sentence for `aria-label`. Never the colour alone. */
  readonly ariaTemplate: (slaMinutes: number) => string;
};

export const URGENCY_META: Record<Urgency, UrgencyMeta> = {
  critical: {
    label: 'Critical',
    icon: Siren,
    textClass: 'text-urgency-critical',
    bgClass: 'bg-urgency-critical-muted',
    borderClass: 'border-urgency-critical',
    shape: 'octagon',
    slaMinutes: 5,
    rank: 0,
    ariaTemplate: (m) => `Urgency: critical, response target ${m} minutes`,
  },
  high: {
    label: 'High',
    icon: TriangleAlert,
    textClass: 'text-urgency-high',
    bgClass: 'bg-urgency-high-muted',
    borderClass: 'border-urgency-high',
    shape: 'triangle',
    slaMinutes: 15,
    rank: 1,
    ariaTemplate: (m) => `Urgency: high, response target ${m} minutes`,
  },
  medium: {
    label: 'Medium',
    icon: CircleAlert,
    textClass: 'text-urgency-medium',
    bgClass: 'bg-urgency-medium-muted',
    borderClass: 'border-urgency-medium',
    shape: 'circle',
    slaMinutes: 60,
    rank: 2,
    ariaTemplate: (m) => `Urgency: medium, response target ${m} minutes`,
  },
  low: {
    label: 'Low',
    icon: Circle,
    textClass: 'text-urgency-low',
    bgClass: 'bg-urgency-low-muted',
    borderClass: 'border-urgency-low',
    shape: 'hollow-circle',
    slaMinutes: 240,
    rank: 3,
    ariaTemplate: (m) => `Urgency: low, response target ${m} minutes`,
  },
};

/** SLA target per urgency. FR-026. Verified by tests/unit/config-invariants. */
export const SLA_MINUTES: Record<Urgency, number> = {
  critical: 5,
  high: 15,
  medium: 60,
  low: 240,
};

/**
 * Safety flags that force an urgency FLOOR (docs/07 §4.5). The model may raise
 * urgency; it may never lower it below these. Kept here so the rule is one
 * array, not scattered comparisons.
 */
export const URGENCY_FLOOR_FLAGS = [
  'medical_critical',
  'self_harm',
  'child_at_risk',
  'violence',
] as const;

export function urgencyRank(u: Urgency): number {
  return URGENCY_META[u].rank;
}
