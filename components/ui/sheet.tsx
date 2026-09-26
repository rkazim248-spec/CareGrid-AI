'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

import { cn } from '@/lib/cn';

/**
 * Sheet / Drawer — docs/04 §5.14
 *
 * Sides: right (desktop map panel), bottom (mobile filters, max 85dvh), left
 * (mobile nav). The bottom variant gets a grab handle; it is `aria-hidden`
 * because it conveys nothing a screen reader needs.
 */
const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;
const SheetPortal = DialogPrimitive.Portal;

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn(
        'fixed inset-0 z-50 bg-scrim',
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
        'motion-reduce:animate-none',
        className,
      )}
      {...props}
    />
  );
}

const SIDE_CLASSES = {
  right: 'inset-y-0 right-0 h-full w-full border-l sm:max-w-[420px]',
  left: 'inset-y-0 left-0 h-full w-[300px] border-r sm:max-w-[300px]',
  bottom:
    'inset-x-0 bottom-0 max-h-[85dvh] rounded-t-sheet border-t',
  top: 'inset-x-0 top-0 border-b',
} as const;

function SheetContent({
  className,
  children,
  side = 'right',
  hideClose = false,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  side?: keyof typeof SIDE_CLASSES;
  hideClose?: boolean;
}) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <DialogPrimitive.Content
        className={cn(
          'fixed z-50 flex flex-col gap-0 border-strong bg-surface shadow-[0_8px_24px_rgba(0,0,0,0.55)]',
          'transition ease-[--motion-ease-standard] duration-[--motion-duration-slow]',
          'motion-reduce:transition-none motion-reduce:duration-[80ms]',
          side === 'right' &&
            'data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right',
          side === 'left' &&
            'data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left',
          side === 'bottom' &&
            'data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom',
          side === 'top' && 'data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top',
          'motion-reduce:data-[state=open]:slide-in-from-0 motion-reduce:data-[state=closed]:slide-out-to-0',
          SIDE_CLASSES[side],
          className,
        )}
        {...props}
      >
        {side === 'bottom' ? (
          <div
            aria-hidden="true"
            className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-pill bg-strong"
          />
        ) : null}

        {!hideClose ? (
          <DialogPrimitive.Close className="absolute top-4 right-4 rounded-control p-1 text-muted opacity-80 transition-colors hover:bg-elevated hover:text-primary focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-focus">
            <X className="size-4" aria-hidden="true" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        ) : null}

        {children}
      </DialogPrimitive.Content>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex shrink-0 flex-col gap-1 border-b border-subtle px-5 py-4 pr-12',
        className,
      )}
      {...props}
    />
  );
}

function SheetBody({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex-1 overflow-y-auto px-5 py-4', className)} {...props} />;
}

function SheetFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex shrink-0 flex-col gap-2 border-t border-subtle px-5 py-4 sm:flex-row sm:justify-end',
        className,
      )}
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn('text-lg leading-tight font-semibold text-primary', className)}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description className={cn('text-sm text-secondary', className)} {...props} />
  );
}

export {
  Sheet,
  SheetPortal,
  SheetOverlay,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetBody,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
