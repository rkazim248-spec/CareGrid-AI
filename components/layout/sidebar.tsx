'use client';

import * as React from 'react';
import Link from 'next/link';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';

import { CareGridMark } from '@/components/brand/caregrid-mark';
import { cn } from '@/lib/cn';
import { IconButton } from '@/components/ui/icon-button';
import { SidebarNav } from '@/components/layout/sidebar-nav';
import { STORAGE_KEYS } from '@/lib/constants';

/**
 * Sidebar — docs/04 §8.1
 *
 * 240px, collapsible to 64px, `lg` (>=1024px) and above only. Below that the
 * TopBar hamburger opens the mobile Sheet instead — a 240px rail on a 375px
 * phone is a sidebar that eats the content.
 *
 * The collapsed state is a UI preference in localStorage (NOT a role, and NOT
 * sent to the server). Read after mount so SSR and hydration agree.
 */
export function Sidebar() {
  const [collapsed, setCollapsed] = React.useState(false);

  React.useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(STORAGE_KEYS.sidebarCollapsed) === '1');
    } catch {
      // Storage unavailable: default to expanded rather than crashing the shell.
    }
  }, []);

  const toggle = React.useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(STORAGE_KEYS.sidebarCollapsed, next ? '1' : '0');
      } catch {
        // Preference is best-effort.
      }
      return next;
    });
  }, []);

  return (
    <aside
      className={cn(
        'hidden shrink-0 border-r border-subtle bg-app lg:flex lg:flex-col',
        collapsed ? 'w-16' : 'w-60',
        'transition-[width] duration-[--motion-duration-base] motion-reduce:transition-none',
      )}
      aria-label="Primary"
    >
      <div
        className={cn(
          'flex h-14 shrink-0 items-center border-b border-subtle px-3',
          collapsed ? 'justify-center' : 'justify-between',
        )}
      >
        <Link href="/" className="flex items-center gap-2 rounded-control focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-focus">
          <WordmarkMark />
          {collapsed ? <span className="sr-only">CareGrid AI</span> : null}
        </Link>
        {collapsed ? null : (
          <IconButton
            label="Collapse the sidebar"
            icon={PanelLeftClose}
            size="sm"
            onClick={toggle}
            className="min-h-8 min-w-8"
          />
        )}
      </div>

      {collapsed ? (
        <div className="flex justify-center py-2">
          <IconButton
            label="Expand the sidebar"
            icon={PanelLeftOpen}
            size="sm"
            onClick={toggle}
            className="min-h-8 min-w-8"
          />
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        <SidebarNav collapsed={collapsed} />
      </div>
    </aside>
  );
}

function WordmarkMark() {
  return (
    <span className="flex items-center gap-2">
      <span className="flex size-7 items-center justify-center rounded-control bg-accent text-on-solid">
        <CareGridMark className="size-4" />
      </span>
      <span className="text-sm font-semibold tracking-tight text-primary">CareGrid AI</span>
    </span>
  );
}
