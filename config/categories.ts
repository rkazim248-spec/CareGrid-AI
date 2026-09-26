/**
 * Incident category metadata — docs/04_UI_UX_DESIGN_SPECIFICATION.md §4.5 rule 4
 * and docs/07_DATABASE_SCHEMA.md §4.2.
 *
 * Exactly 11 values. `similarityGroup` is what makes "same category" vs
 * "compatible category" a data decision rather than an if-statement: two
 * incidents inside 500 m only auto-suggest a duplicate when their groups match
 * (docs/07 §9.4 gate 2). `medical` and `traffic_accident` are deliberately
 * different groups even 20 m apart.
 */

import {
  CarFront,
  CloudLightning,
  Construction,
  Flame,
  HandHeart,
  HeartPulse,
  HelpCircle,
  ShieldAlert,
  ThermometerSun,
  UserSearch,
  Waves,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { IncidentCategory } from '@/types/enums';

export type CategoryMeta = {
  readonly label: string;
  readonly icon: LucideIcon;
  /** Duplicate-similarity group. docs/07 §4.2 */
  readonly group: CategorySimilarityGroup;
  /** Used for the analytics distribution chart series. */
  readonly chartColorClass: string;
};

export type CategorySimilarityGroup =
  | 'medical'
  | 'fire'
  | 'road'
  | 'weather'
  | 'person'
  | 'crime'
  | 'infra'
  | 'aid'
  | 'other';

export const CATEGORY_META: Record<IncidentCategory, CategoryMeta> = {
  medical: {
    label: 'Medical',
    icon: HeartPulse,
    group: 'medical',
    chartColorClass: 'fill-urgency-critical',
  },
  fire: {
    label: 'Fire',
    icon: Flame,
    group: 'fire',
    chartColorClass: 'fill-urgency-high',
  },
  traffic_accident: {
    label: 'Road accident',
    icon: CarFront,
    group: 'road',
    chartColorClass: 'fill-urgency-high',
  },
  flood: {
    label: 'Flooding',
    icon: Waves,
    group: 'weather',
    chartColorClass: 'fill-urgency-medium',
  },
  heatwave: {
    label: 'Heatwave',
    icon: ThermometerSun,
    group: 'weather',
    chartColorClass: 'fill-urgency-medium',
  },
  severe_storm: {
    label: 'Severe storm',
    icon: CloudLightning,
    group: 'weather',
    chartColorClass: 'fill-urgency-low',
  },
  missing_person: {
    label: 'Missing person',
    icon: UserSearch,
    group: 'person',
    chartColorClass: 'fill-urgency-low',
  },
  violence_crime: {
    label: 'Violence or crime',
    icon: ShieldAlert,
    group: 'crime',
    chartColorClass: 'fill-urgency-critical',
  },
  infrastructure: {
    label: 'Infrastructure',
    icon: Construction,
    group: 'infra',
    chartColorClass: 'fill-urgency-low',
  },
  community_aid: {
    label: 'Community aid',
    icon: HandHeart,
    group: 'aid',
    chartColorClass: 'fill-info',
  },
  other: {
    label: 'Other',
    icon: HelpCircle,
    group: 'other',
    chartColorClass: 'fill-neutral',
  },
};

/** Used by the report form's category selector and the queue filter grouping. */
export const CATEGORY_LIST: readonly IncidentCategory[] = Object.keys(
  CATEGORY_META,
) as IncidentCategory[];

export function categoryLabel(category: IncidentCategory): string {
  return CATEGORY_META[category].label;
}
