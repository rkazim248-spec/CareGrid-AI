'use client';

import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';

import { cn } from '@/lib/cn';

/**
 * Tooltip — docs/04 §5.19
 *
 * A tooltip is NEVER the only source of information (docs/04 §5.19) and there
 * are no hover-only affordances. It opens on focus as well as hover, and
 * Escape dismisses it.
 *
 * The `TooltipHint` wrapper exists for one specific problem: a disabled button
 * cannot receive focus, so the tooltip trigger is wrapped in a focusable span
 * and the reason is ALSO rendered as visible helper text wherever the control is
 * disabled (FR-017).
 */
const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 max-w-64 rounded-control border border-strong bg-elevated px-3 py-1.5 text-xs text-primary',
          'shadow-[0_1px_2px_rgba(0,0,0,0.44)]',
          'data-[state=delayed-open]:animate-in data-[state=closed]:animate-out data-[state=delayed-open]:fade-in-0 data-[state=closed]:fade-out-0',
          'motion-reduce:animate-none',
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

/** Convenience: wrap any trigger with a text tooltip. */
function TooltipHint({
  content,
  children,
  side = 'bottom',
  asChild = true,
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  asChild?: boolean;
}) {
  if (!content) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild={asChild}>{children}</TooltipTrigger>
      <TooltipContent side={side}>{content}</TooltipContent>
    </Tooltip>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, TooltipHint };
