import { cn } from '@/lib/cn';

/**
 * Skeleton — docs/04 §5.21
 *
 * Mirrors the REAL geometry of what it replaces: a queue-row skeleton is the
 * exact row height and column widths, a KPI skeleton is the tile. A skeleton
 * with the wrong shape causes a 300ms layout jump on every realtime update
 * (anti-pattern A8).
 *
 * `aria-hidden` because the loading region is announced once by its container
 * via `aria-busy` + an sr-only label — a screen reader should hear "Loading the
 * incident queue", not forty empty boxes.
 */
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn('skeleton-fill rounded-sm', className)}
      {...props}
    />
  );
}

/**
 * The announced loading wrapper. `label` names the region so a screen-reader
 * user knows what is coming.
 */
function SkeletonRegion({
  label,
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & { label: string }) {
  return (
    <div aria-busy="true" className={className} {...props}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

export { Skeleton, SkeletonRegion };
