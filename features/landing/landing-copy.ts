/**
 * Landing page copy — docs/04_UI_UX_DESIGN_SPECIFICATION.md §13.1, §14, §15.
 *
 * Every string on a public surface is collected here so the honest voice is one
 * file rather than a habit: no exclamation marks (anti-pattern A4), no
 * "successfully", no "AI decided", no claim of an exact location, and no
 * suggestion that this system is connected to any government, hospital, or
 * emergency service (docs/04 §15.1–§15.5).
 *
 * This file deliberately holds NO urgency/status tokens. The marketing flow is
 * not an operational row, so it must not borrow `UrgencyBadge` styling to look
 * urgent (docs/04 §1.3 A2).
 */

import {
  Activity,
  BarChart3,
  Bot,
  CircleCheck,
  CopyCheck,
  Map as MapIcon,
  Route,
  ShieldCheck,
  Siren,
  Sparkles,
  UserRound,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
// Aliased: `Route` is already the lucide icon used for the dispatch capability.
import type { Route as NextRoute } from 'next';

export const LANDING = {
  wordmark: 'CareGrid AI',
  signIn: 'Sign in',
  createAccount: 'Create an account',
  headline: 'Smarter Emergency Response. Connected Communities.',
  subline:
    'CareGrid AI helps communities report emergencies, add context, and follow incidents through a clear response process.',
  howItWorksTitle: 'How it works',
  howItWorksLead: 'A report becomes a shared record that people can review and follow.',
  capabilitiesTitle: 'Tools for a coordinated response',
  capabilitiesLead:
    'Useful context for the people responsible for reviewing and responding to a report.',
  trustTitle: 'What this system does not do',
  trustLead:
    'AI can help organize a report. Emergency services and human responders remain responsible for action.',
  footerAbout:
    'A community incident reporting platform for organizing information and tracking response.',
} as const;

export type LandingStep = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIcon;
};

/** The public explanation mirrors the real report and response flow. */
export const HOW_IT_WORKS: readonly LandingStep[] = [
  {
    id: 'report',
    label: 'Report',
    description:
      'Describe what is happening and add supporting evidence when it is safe to do so.',
    icon: Siren,
  },
  {
    id: 'triage',
    label: 'AI Triage',
    description:
      'The available report information can be analyzed to suggest a category and urgency for human review.',
    icon: Sparkles,
  },
  {
    id: 'location',
    label: 'Location',
    description:
      'Share a browser location or enter an address so reviewers have useful place context.',
    icon: MapIcon,
  },
  {
    id: 'incident',
    label: 'Incident',
    description:
      'Submitting creates a saved incident record with a reference and current status.',
    icon: CopyCheck,
  },
  {
    id: 'response',
    label: 'Community response',
    description:
      'A dispatcher can review the information and coordinate an eligible community responder.',
    icon: Users,
  },
  {
    id: 'tracking',
    label: 'Tracking',
    description:
      'Return to the saved report to follow its status, location, evidence, and available analysis.',
    icon: CircleCheck,
  },
];

export type LandingCapability = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly icon: LucideIcon;
};

export const CAPABILITIES: readonly LandingCapability[] = [
  {
    id: 'triage',
    title: 'Multimodal AI triage',
    description:
      'Available report text and photo evidence can inform an advisory category and urgency estimate for human review.',
    icon: Sparkles,
  },
  {
    id: 'map',
    title: 'Location intelligence',
    description:
      'Location context helps authorized operations users review incidents alongside an equivalent accessible list.',
    icon: MapIcon,
  },
  {
    id: 'duplicates',
    title: 'Incident tracking',
    description:
      'Saved incident records keep submitted details, available evidence, and status together for later review.',
    icon: CopyCheck,
  },
  {
    id: 'dispatch',
    title: 'Community response',
    description:
      'Operations users can coordinate eligible responders using the incident information available to them.',
    icon: Route,
  },
  {
    id: 'status',
    title: 'Clear status updates',
    description:
      'Keep the current incident status visible alongside the saved report details.',
    icon: Activity,
  },
  {
    id: 'analytics',
    title: 'Accountable review',
    description:
      'AI suggestions are marked separately from confirmed incident details and remain subject to human review.',
    icon: BarChart3,
  },
];

export type TrustPoint = {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly icon: LucideIcon;
};

/** docs/04 §1.2 P5 (honesty over reassurance) and §15.4 (dispatch wording). */
export const TRUST_POINTS: readonly TrustPoint[] = [
  {
    id: 'advisory',
    title: 'The AI is advisory',
    body: 'CareGrid AI produces an estimate from what was reported. It does not verify an incident, set urgency on its own, or assign anyone.',
    icon: Bot,
  },
  {
    id: 'human',
    title: 'A human dispatcher reviews and assigns',
    body: 'Every incident is read by a dispatcher, who confirms the details and assigns a verified community responder.',
    icon: UserRound,
  },
  {
    id: 'no-emergency',
    title: 'No emergency service is contacted',
    body: 'This system does not call, message, or notify any police, ambulance, fire, or government service. It routes community responders only.',
    icon: ShieldCheck,
  },
];

export type FooterLink = {
  readonly label: string;
  /**
   * `Route`, not `string`: `next.config.ts` sets `typedRoutes: true`, so a
   * plain string in a `<Link href>` is a type error rather than a broken link
   * discovered at click time.
   */
  readonly href: NextRoute;
};

/** No fake social links and no partner logos (docs/04 §1.3). */
export const FOOTER_PRODUCT_LINKS: readonly FooterLink[] = [
  { label: 'Report an incident', href: '/report' },
  { label: 'How it works', href: '/#how-it-works' },
  { label: 'Safety', href: '/#safety' },
  { label: 'Privacy summary', href: '/settings?tab=privacy' },
];
