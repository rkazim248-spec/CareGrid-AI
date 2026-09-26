/**
 * Incident status metadata — docs/04_UI_UX_DESIGN_SPECIFICATION.md §6
 *
 * The complete 11-value mapping. `terminal` drives queue filtering and
 * pagination; the "next actions" list is documentation of the transition table
 * in docs/07 §4.3, shown as tooltips so a dispatcher sees what is legal
 * without memorising the table.
 */

import {
  Ban,
  BadgeCheck,
  CircleCheck,
  CircleSlash,
  ClipboardCheck,
  GitMerge,
  Inbox,
  Lock,
  MapPin,
  Navigation,
  UserPlus,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { IncidentStatus } from '@/types/enums';

export type StatusMeta = {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly textClass: string;
  readonly bgClass: string;
  readonly borderClass: string;
  /** Terminal statuses are excluded from the live queue. */
  readonly terminal: boolean;
  /** Sort weight for the queue (FR-071). */
  readonly rank: number;
  /** Plain-language "what happens next" for the citizen /track view. */
  readonly citizenNext: string;
  /** Legal next transitions, for tooltips and the optimistic-action bar. */
  readonly nextActions: readonly IncidentStatus[];
};

export const STATUS_META: Record<IncidentStatus, StatusMeta> = {
  new: {
    label: 'New',
    icon: Inbox,
    textClass: 'text-status-new',
    bgClass: 'bg-neutral-muted',
    borderClass: 'border-default',
    terminal: false,
    rank: 0,
    citizenNext: 'Your report has been received and is waiting to be looked at.',
    nextActions: ['triaged', 'verified', 'cancelled', 'false_alarm'],
  },
  triaged: {
    label: 'Triaged',
    icon: ClipboardCheck,
    textClass: 'text-status-triaged',
    bgClass: 'bg-accent-muted',
    borderClass: 'border-accent',
    terminal: false,
    rank: 1,
    citizenNext: 'A dispatcher is reading the report now.',
    nextActions: ['verified', 'assigned', 'resolved', 'cancelled', 'false_alarm', 'merged'],
  },
  verified: {
    label: 'Verified',
    icon: BadgeCheck,
    textClass: 'text-status-verified',
    bgClass: 'bg-success-muted',
    borderClass: 'border-success',
    terminal: false,
    rank: 2,
    citizenNext: 'A dispatcher has confirmed the report. Someone is being sent.',
    nextActions: ['assigned', 'resolved', 'closed', 'cancelled', 'false_alarm', 'merged'],
  },
  assigned: {
    label: 'Assigned',
    icon: UserPlus,
    textClass: 'text-status-assigned',
    bgClass: 'bg-status-assigned-muted',
    borderClass: 'border-status-assigned',
    terminal: false,
    rank: 3,
    citizenNext: 'A responder has been assigned and is getting ready.',
    nextActions: ['en_route', 'on_scene', 'resolved', 'closed', 'cancelled', 'false_alarm'],
  },
  en_route: {
    label: 'En route',
    icon: Navigation,
    textClass: 'text-status-en-route',
    bgClass: 'bg-info-muted',
    borderClass: 'border-info',
    terminal: false,
    rank: 4,
    citizenNext: 'A responder is on the way.',
    nextActions: ['on_scene', 'resolved', 'closed', 'cancelled', 'false_alarm'],
  },
  on_scene: {
    label: 'On scene',
    icon: MapPin,
    textClass: 'text-status-on-scene',
    bgClass: 'bg-status-on-scene-muted',
    borderClass: 'border-status-on-scene',
    terminal: false,
    rank: 5,
    citizenNext: 'A responder is at the location.',
    nextActions: ['resolved', 'closed', 'false_alarm'],
  },
  resolved: {
    label: 'Resolved',
    icon: CircleCheck,
    textClass: 'text-status-resolved',
    bgClass: 'bg-success-muted',
    borderClass: 'border-success',
    terminal: false,
    rank: 6,
    citizenNext: 'The responder has finished. A dispatcher will close the report.',
    nextActions: ['closed'],
  },
  closed: {
    label: 'Closed',
    // docs/04 §2.7 note: the label uses text-secondary (#A8B6C6, 8.64:1) because
    // the status token itself is only 4.06:1 and badge text is below 18.66px.
    icon: Lock,
    textClass: 'text-secondary',
    bgClass: 'bg-neutral-muted',
    borderClass: 'border-default',
    terminal: true,
    rank: 7,
    citizenNext: 'This report is closed.',
    nextActions: [],
  },
  cancelled: {
    label: 'Cancelled',
    icon: Ban,
    textClass: 'text-status-cancelled',
    bgClass: 'bg-neutral-muted',
    borderClass: 'border-default',
    terminal: true,
    rank: 8,
    citizenNext: 'This report was cancelled.',
    nextActions: ['closed'],
  },
  false_alarm: {
    label: 'False alarm',
    icon: CircleSlash,
    textClass: 'text-status-false-alarm',
    bgClass: 'bg-status-false-alarm-muted',
    borderClass: 'border-status-false-alarm',
    terminal: true,
    rank: 9,
    citizenNext: 'A dispatcher marked this report as a false alarm.',
    nextActions: ['closed'],
  },
  merged: {
    label: 'Merged',
    icon: GitMerge,
    textClass: 'text-status-merged',
    bgClass: 'bg-neutral-muted',
    borderClass: 'border-default',
    terminal: true,
    rank: 10,
    citizenNext: 'This report was linked to an earlier report of the same incident.',
    nextActions: [],
  },
};

export function isTerminal(status: IncidentStatus): boolean {
  return STATUS_META[status].terminal;
}

/** The lifecycle path a citizen is shown as progress steps on /track. */
export const CITIZEN_PROGRESS_STEPS = [
  'new',
  'triaged',
  'verified',
  'assigned',
  'en_route',
  'on_scene',
  'resolved',
] as const satisfies readonly IncidentStatus[];
