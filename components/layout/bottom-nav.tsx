'use client';


import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/cn';
import { MOCK_NOTIFICATIONS } from '@/lib/mock-data';
import { BOTTOM_NAV_ITEMS } from '@/config/nav';
import { useResolvedSession } from '@/components/providers/session-provider';

/**
 * BottomNav — docs/04 §8.3
 *
 * Fixed bottom bar, 64px + safe-area, for the responder on a phone. FIVE items
 * only: it is a thumb-reach affordance and five is the most that stays
 * comfortable. Everything else lives in the nav sheet and /profile.
 *
 * Hidden at `md` and above, where the sidebar is visible. On mobile the page
 * content needs `pb-20` so the last row is never covered.
 */
export function BottomNav() {

  const { isAllowed } = useResolvedSession();
  const pathname = usePathname();
  const unread = MOCK_NOTIFICATIONS.filter((n) => !n.read).length;

  const items = BOTTOM_NAV_ITEMS.filter((item) => isAllowed(item.href));
  if (items.length === 0) return null;


  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-subtle bg-app pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="flex">
        {items.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href;
          const badge = item.badge === 'notifications' ? unread : 0;
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                aria-label={badge ? `${item.label}, ${badge} unread` : item.label}
                className={cn(
                  'flex min-h-16 flex-col items-center justify-center gap-1 px-1 text-2xs',
                  'transition-colors focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-focus focus-visible:ring-inset',
                  active ? 'text-accent' : 'text-muted hover:text-secondary',
                )}
              >
                <span className="relative">
                  <Icon className="size-icon-md" aria-hidden="true" />
                  {badge > 0 ? (
                    <span
                      aria-hidden="true"
                      className="absolute -top-1 -right-1.5 flex min-w-3.5 items-center justify-center rounded-pill bg-danger px-1 text-[9px] leading-3.5 font-semibold text-inverse"
                    >
                      {badge > 9 ? '9+' : badge}
                    </span>
                  ) : null}
                </span>
                <span className="truncate">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
