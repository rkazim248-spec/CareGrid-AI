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
  headline: 'Community incident reporting, routed to the people who can help.',
  subline:
    'CareGrid AI turns an unstructured report into a located, deduplicated incident that a dispatcher and a verified community responder can act on.',
  howItWorksTitle: 'How it works',
  howItWorksLead: 'Four steps from a sentence typed in a hurry to a resolved incident.',
  capabilitiesTitle: 'Core capabilities',
  capabilitiesLead:
    'What the platform does, and what it deliberately does not do.',
  trustTitle: 'What this system does not do',
  trustLead:
    'An emergency product has to be honest about its limits, so they are stated here rather than in a footnote.',
  footerAbout:
    'A demonstration incident-routing platform for community reports and community responders.',
  footerContactLead: 'Email',
  footerContactNote:
    'Demo enquiries are handled through the project repository, not by a support desk.',
  mailto: 'hello@caregrid.example',
} as const;

export type LandingStep = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIcon;
};

/** Report -> AI Triage -> Responder -> Resolution. docs/04 §13.1. */
export const HOW_IT_WORKS: readonly LandingStep[] = [
  {
    id: 'report',
    label: 'Report',
    description:
      'Describe what is happening in your own words, add a photo or a voice note, and optionally share your location.',
    icon: Siren,
  },
  {
    id: 'triage',
    label: 'AI Triage',
    description:
      'CareGrid AI suggests a category, an urgency estimate, and any safety flags. A person checks every field before it counts.',
    icon: Sparkles,
  },
  {
    id: 'responder',
    label: 'Responder',
    description:
      'A dispatcher reads the report and assigns a verified community responder who is available and close by.',
    icon: Users,
  },
  {
    id: 'resolution',
    label: 'Resolution',
    description:
      'The responder marks arrival and resolution, and a dispatcher closes the report and keeps the record.',
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
      'Text, photos, and voice notes are read together to suggest a category, an urgency estimate, and the resources an incident needs.',
    icon: Sparkles,
  },
  {
    id: 'map',
    title: 'Live emergency map',
    description:
      'Active incidents and responder availability on one map, with an equivalent list view so nothing is map-only.',
    icon: MapIcon,
  },
  {
    id: 'duplicates',
    title: 'Smart duplicate detection',
    description:
      'Nearby reports about the same incident are suggested for linking, so responders are not sent to the same place twice.',
    icon: CopyCheck,
  },
  {
    id: 'dispatch',
    title: 'Responder dispatch',
    description:
      'A dispatcher assigns a verified responder by capability and distance, and sees acceptance without refreshing.',
    icon: Route,
  },
  {
    id: 'status',
    title: 'Real-time status',
    description:
      'Status changes reach the reporter, the dispatcher, and the assigned responder as they happen.',
    icon: Activity,
  },
  {
    id: 'analytics',
    title: 'Risk analytics',
    description:
      'Incident volume, response times, and repeat locations, so a neighbourhood can see where help keeps being needed.',
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
