import * as React from 'react';

import { cn } from '@/lib/cn';
import { SkeletonRegion } from '@/components/ui/skeleton';

/**
 * Loading skeletons for the auth forms.
 *
 * ---------------------------------------------------------------------------
 * WHY THE GEOMETRY IS EXPLICIT RATHER THAN GENERIC
 * ---------------------------------------------------------------------------
 * A generic "loading…" block makes the page jump when the form arrives, which in
 * a sign-in flow means a person clicking where the submit button used to be. The
 * shapes below match the real form: a summary region, two labelled fields, a
 * link, a primary button, a divider, and a secondary button.
 *
 * Not interactive and not announced as a form — `SkeletonRegion` carries the
 * `aria-busy` and a single sr-only label, so a screen-reader user hears
 * "Loading sign-in form" once rather than six empty fields.
 */

function FieldSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <div className="skeleton-fill h-3.5 w-16 rounded-sm" />
      <div className="skeleton-fill h-12 rounded-control md:h-10" />
    </div>
  );
}

function ButtonSkeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton-fill h-12 rounded-control', className)} />;
}

export function LoginFormSkeleton() {
  return (
    <SkeletonRegion label="Loading the sign-in form" className="flex flex-col gap-4">
      <FieldSkeleton />
      <FieldSkeleton />
      <div className="skeleton-fill h-4 w-28 self-end rounded-sm" />
      <ButtonSkeleton />
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-subtle" />
        <div className="skeleton-fill h-3 w-6 rounded-sm" />
        <div className="h-px flex-1 bg-subtle" />
      </div>
      <ButtonSkeleton />
      <div className="skeleton-fill mx-auto h-4 w-40 rounded-sm" />
    </SkeletonRegion>
  );
}

export function SignupFormSkeleton() {
  return (
    <SkeletonRegion label="Loading the sign-up form" className="flex flex-col gap-4">
      <FieldSkeleton />
      <FieldSkeleton />
      <FieldSkeleton />
      <div className="skeleton-fill h-20 rounded-card" />
      <div className="skeleton-fill h-5 w-64 rounded-sm" />
      <ButtonSkeleton />
      <div className="skeleton-fill mx-auto h-4 w-36 rounded-sm" />
    </SkeletonRegion>
  );
}

export function ForgotPasswordFormSkeleton() {
  return (
    <SkeletonRegion label="Loading the password reset form" className="flex flex-col gap-4">
      <div className="skeleton-fill h-4 w-72 rounded-sm" />
      <FieldSkeleton />
      <ButtonSkeleton />
      <div className="skeleton-fill mx-auto h-4 w-28 rounded-sm" />
    </SkeletonRegion>
  );
}
