'use client';

import Link from 'next/link';
import { Circle, Info, OctagonAlert, TriangleAlert } from 'lucide-react';
import type { Route } from 'next';

import { RelativeTime } from '@/components/domain';
import { cn } from '@/lib/cn';
import type { AppNotification, NotificationSeverity } from '@/types';

/**
 * One notification row — docs/04 §13.14.
 *
 * Severity is a 3px left rule + a fixed icon + a WORD, never colour alone
 * (docs/04 §1.2 P3, §2.12). Unread is a `Circle` glyph AND the word "Unread", for
 * the same reason: a bold title is not a state a screen reader can be told
 * about, and a colour is not a state anyone can see.
 */
const SEVERITY: Record<
  NotificationSeverity,
  { rule: string; icon: typeof Info; label: string }
> = {
  critical: { rule: 'border-l-danger', icon: OctagonAlert, label: 'Critical' },
  warning: { rule: 'border-l-warning', icon: TriangleAlert, label: 'Warning' },
  info: { rule: 'border-l-info', icon: Info, label: 'Information' },
};

/**
 * `AppNotification.link` is `string | null` because it is a path in an API
 * payload. `typedRoutes` needs the `Route` union, so the value is narrowed here
 * once, with a runtime guard: an external or malformed link renders no "Open"
 * action rather than navigating somewhere unexpected.
 */
function toRoute(link: string): Route | null {
  return link.startsWith('/') ? (link as Route) : null;
}

export function NotificationRow({
  notification,
  onOpen,
}: {
  notification: AppNotification;
  onOpen: (id: string) => void;
}) {
  const severity = SEVERITY[notification.severity];
  const SeverityIcon = severity.icon;
  const href = notification.link ? toRoute(notification.link) : null;

  return (
    <li
      className={cn(
        'flex flex-col gap-1.5 border-l-[3px] border-y border-r border-subtle bg-surface px-3 py-3',
        severity.rule,
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <SeverityIcon className="size-4 text-secondary" aria-hidden="true" />
        <span className="text-2xs font-semibold tracking-[0.06em] text-muted uppercase">
          {severity.label}
        </span>
        {notification.read ? null : (
          <span className="inline-flex items-center gap-1.5 text-2xs font-semibold tracking-[0.06em] text-accent uppercase">
            <Circle className="size-2.5" aria-hidden="true" />
            Unread
          </span>
        )}
        <RelativeTime iso={notification.createdAt} className="ml-auto" />
      </div>

      <p className="text-sm font-semibold text-primary">{notification.title}</p>
      <p className="clamp-2 max-w-[72ch] text-sm text-secondary">{notification.body}</p>

      {href ? (
        <div className="pt-1">
          <Link
            href={href}
            onClick={() => onOpen(notification.notificationId)}
            className="inline-flex min-h-11 items-center text-sm text-accent underline-offset-4 hover:underline focus-visible:ring-[2px] focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app focus-visible:outline-none"
          >
            Open
          </Link>
        </div>
      ) : null}
    </li>
  );
}
