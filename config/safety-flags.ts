/**
 * Safety-flag chip metadata — docs/04_UI_UX_DESIGN_SPECIFICATION.md §7.3
 *
 * Every flag has a fixed chip. The tone split is deliberate: the four flags
 * that force an urgency floor are `danger`, the rest are `warning`. A flag that
 * cannot change a decision should not be painted like one that can.
 */

import {
  Baby,
  CopyCheck,
  Eye,
  Flame,
  LifeBuoy,
  Lock,
  MapPinOff,
  ShieldAlert,
  Users,
  Waves,
  Wind,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { SafetyFlag } from '@/types/enums';

export type SafetyFlagMeta = {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly tone: 'danger' | 'warning' | 'accent';
};

export const SAFETY_FLAG_META: Record<SafetyFlag, SafetyFlagMeta> = {
  medical_critical: { label: 'Critical injury reported', icon: Lock, tone: 'danger' },
  self_harm: { label: 'Self-harm mentioned', icon: LifeBuoy, tone: 'danger' },
  violence: { label: 'Violence reported', icon: ShieldAlert, tone: 'danger' },
  child_at_risk: { label: 'Child at risk', icon: Baby, tone: 'danger' },
  injured_trapped: { label: 'Person trapped', icon: Lock, tone: 'danger' },
  electrical_hazard: { label: 'Electrical hazard', icon: Zap, tone: 'warning' },
  gas_leak: { label: 'Gas leak', icon: Wind, tone: 'warning' },
  fire: { label: 'Fire', icon: Flame, tone: 'warning' },
  flood_rising: { label: 'Rising water', icon: Waves, tone: 'warning' },
  crowd_panic: { label: 'Crowd in danger', icon: Users, tone: 'warning' },
  possible_duplicate: { label: 'Possible duplicate', icon: CopyCheck, tone: 'accent' },
  unclear_location: { label: 'Unclear location', icon: MapPinOff, tone: 'warning' },
  low_confidence: { label: 'Low AI confidence', icon: Eye, tone: 'warning' },
};
