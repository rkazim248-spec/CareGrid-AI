import type { ReactNode } from 'react';

export function ReportStepHeading({
  number,
  title,
  description,
}: {
  number: number;
  title: string;
  description?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <span
        aria-hidden="true"
        className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-control bg-accent-muted font-mono text-xs font-semibold text-accent"
      >
        {String(number).padStart(2, '0')}
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="text-lg leading-tight font-semibold text-primary">{title}</h2>
        {description ? <p className="text-sm leading-6 text-secondary">{description}</p> : null}
      </div>
    </div>
  );
}
