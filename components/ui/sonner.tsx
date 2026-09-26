'use client';

import * as React from 'react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';

import { useTheme } from '@/components/providers/theme-provider';

/**
 * Toaster — docs/04 §5.12
 *
 * One instance, mounted in the root layout. Position: bottom-right at >= 768px,
 * top-center below (never the thumb zone, never covering a sticky primary
 * action). Max 3 stacked. `success`/`info` auto-dismiss at 6s; `error` is
 * PERSISTENT because a disappearing error cannot be acted on.
 *
 * `richColors` is intentionally OFF: sonner's default palettes are not in our
 * token set, and a toast must not invent a colour the design system has never
 * seen. Severity is carried by the icon and the border token instead.
 */
export function Toaster(props: ToasterProps) {
  const { resolved } = useTheme();

  return (
    <Sonner
      theme={resolved}
      className="toaster group"
      position="bottom-right"
      visibleToasts={3}
      closeButton
      duration={6000}
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-surface group-[.toaster]:text-primary group-[.toaster]:border group-[.toaster]:border-default group-[.toaster]:shadow-[0_16px_48px_rgba(0,0,0,0.62)]',
          description: 'group-[.toast]:text-secondary',
          actionButton:
            'group-[.toast]:bg-accent group-[.toast]:text-on-solid group-[.toast]:rounded-control',
          cancelButton: 'group-[.toast]:bg-elevated group-[.toast]:text-secondary group-[.toast]:rounded-control',
          closeButton: 'group-[.toast]:bg-elevated group-[.toast]:text-secondary',
        },
      }}
      style={
        {
          '--normal-bg': 'var(--cg-bg-surface)',
          '--normal-text': 'var(--cg-text-primary)',
          '--normal-border': 'var(--cg-border-default)',
        } as React.CSSProperties
      }
      {...props}
    />
  );
}
