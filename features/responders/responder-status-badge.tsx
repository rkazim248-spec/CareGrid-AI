import { BadgeCheck, CircleCheck, Clock, Eye, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { Badge } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { ResponderStatus, VerificationStatus } from '@/types';

/**
 * Responder status / verification badges.
 *
 * These exist because `StatusBadge` is contractually an INCIDENT status badge
 * (docs/04 §6): its label, icon and colour all come from `STATUS_META`, and
 * passing a responder status to it would render an incident status that never
 * happened. A responder's availability and their verification are different
 * vocabularies and get their own fixed icon + text + colour tables here.
 *
 * Both are icon + text + colour, so neither is colour alone (docs/04 §2.12).
 */

type Style = { label: string; className: string; Icon: LucideIcon; spoken: string };

const STATUS: Record<ResponderStatus, Style> = {
  available: {
    label: 'Available',
    className: 'border-success bg-success-muted text-success',
    Icon: CircleCheck,
    spoken: 'Available. Dispatchers can assign this responder.',
  },
  busy: {
    label: 'Busy',
    className: 'border-warning bg-warning-muted text-warning-fg-muted',
    Icon: Clock,
    spoken: 'Busy with another incident.',
  },
  offline: {
    label: 'Offline',
    className: 'border-default bg-neutral-muted text-secondary',
    Icon: X,
    spoken: 'Offline. Not shown on the map and not in the candidate list.',
  },
};

const VERIFICATION: Record<VerificationStatus, Style> = {
  verified: {
    label: 'Verified',
    className: 'border-success bg-success-muted text-success',
    Icon: BadgeCheck,
    spoken: 'Credentials checked by an administrator.',
  },
  pending: {
    label: 'Awaiting verification',
    className: 'border-warning bg-warning-muted text-warning-fg-muted',
    Icon: Eye,
    spoken: 'Awaiting admin verification. Cannot be assigned yet.',
  },
  unverified: {
    label: 'Not verified',
    className: 'border-default bg-neutral-muted text-secondary',
    Icon: Eye,
    spoken: 'Not verified. Cannot be assigned yet.',
  },
  rejected: {
    label: 'Verification rejected',
    className: 'border-danger bg-danger-muted text-danger-fg-muted',
    Icon: X,
    spoken: 'Verification was rejected by an administrator.',
  },
};

export function ResponderStatusBadge({
  status,
  size = 'sm',
  className,
}: {
  status: ResponderStatus;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return <BadgeImpl style={STATUS[status]} size={size} className={className} />;
}

export function ResponderVerificationBadge({
  verification,
  size = 'sm',
  className,
}: {
  verification: VerificationStatus;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return <BadgeImpl style={VERIFICATION[verification]} size={size} className={className} />;
}

function BadgeImpl({
  style,
  size,
  className,
}: {
  style: Style;
  size: 'sm' | 'md';
  className?: string;
}) {
  const Icon = style.Icon;
  return (
    <Badge
      variant="default"
      size={size}
      className={cn(style.className, className)}
      aria-label={style.spoken}
      title={style.label}
    >
      <Icon aria-hidden="true" />
      {style.label}
    </Badge>
  );
}
