'use client';

import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';

import { cn } from '@/lib/cn';

/**
 * Tabs — docs/04 §5.15
 *
 * A tab that changes what the user is looking at belongs in the URL
 * (`?tab=trend`) so the view is shareable and the Back button works. Tabs that
 * only toggle a sub-panel inside a card may be local state.
 */
const Tabs = TabsPrimitive.Root;

function TabsList({
  className,
  variant = 'underline',
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & {
  variant?: 'underline' | 'pill' | 'enclosed';
}) {
  return (
    <TabsPrimitive.List
      className={cn(
        'inline-flex items-center',
        variant === 'underline' && 'h-10 gap-1 border-b border-subtle',
        variant === 'pill' && 'h-9 gap-1 rounded-control bg-elevated p-1',
        variant === 'enclosed' && 'h-auto gap-1 rounded-control border border-default bg-transparent p-1',
        className,
      )}
      {...props}
    />
  );
}

function TabsTrigger({
  className,
  variant = 'underline',
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger> & {
  variant?: 'underline' | 'pill' | 'enclosed';
}) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'inline-flex items-center justify-center gap-2 whitespace-nowrap px-3 text-sm font-medium',
        'text-secondary transition-colors duration-[--motion-duration-fast]',
        'hover:text-primary',
        'focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app',
        'disabled:pointer-events-none disabled:opacity-45',
        'data-[state=active]:text-primary',
        '[&_svg]:size-4 [&_svg]:shrink-0',
        variant === 'underline' &&
          'h-10 rounded-t-control border-b-2 border-transparent data-[state=active]:border-accent',
        variant === 'pill' &&
          'h-7 rounded-sm data-[state=active]:bg-surface data-[state=active]:text-primary',
        variant === 'enclosed' &&
          'h-9 rounded-sm border border-transparent data-[state=active]:border-default data-[state=active]:bg-surface',
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      className={cn('focus-visible:outline-none', className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
