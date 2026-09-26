'use client';

import { Ban, BadgeCheck, Clock } from 'lucide-react';

import { Badge } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { AccountStatus } from '@/types';

/**
 * Account status badge — docs/04 §13.15.
 *
 * `StatusBadge` is for INCIDENT statuses; the account status set is a different
 * union with different meanings, so it gets its own small mapping rather than
 * being forced through `STATUS_META`. Same contract though: colour + icon +
 * always-visible text, never colour alone (docs/04 §1.2 P3, §2.12).
 */
const ACCOUNT_STATUS: Record<
  AccountStatus,
  { label: string; icon: typeof Clock; className: string; spoken: string }
> = {
  active: {
    label: 'Active',
    icon: BadgeCheck,
    className: 'border-success bg-success-muted text-success',
    spoken: 'Account status: active',
  },
  pending_verification: {
    label: 'Awaiting review',
    icon: Clock,
    className: 'border-warning bg-warning-muted text-warning-fg-muted',
    spoken: 'Account status: awaiting review by an administrator',
  },
  suspended: {
    label: 'Suspended',
    icon: Ban,
    className: 'border-danger bg-danger-muted text-danger-fg-muted',
    spoken: 'Account status: suspended. It cannot be used to sign in',
  },
  disabled: {
    label: 'Disabled',
    icon: Ban,
    className: 'border-danger bg-danger-muted text-danger-fg-muted',
    spoken: 'Account status: disabled',
  },
};

export function AccountStatusBadge({ status }: { status: AccountStatus }) {
  const meta = ACCOUNT_STATUS[status];
  const Icon = meta.icon;

  return (
    <Badge
      variant="default"
      size="sm"
      className={cn(meta.className)}
      aria-label={meta.spoken}
      title={meta.label}
    >
      <Icon aria-hidden="true" />
      {meta.label}
    </Badge>
  );
}
