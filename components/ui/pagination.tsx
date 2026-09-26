'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';

/**
 * Pagination — docs/04 §5.17
 *
 * Cursor-based, matching the `data.page.{nextCursor, hasMore, limit}` envelope
 * in docs/08 §1.5. NO page numbers: with a cursor, "page 3" is not a real
 * address and rendering it would be a lie.
 */
export type PaginationProps = {
  /** "Rows 26–50" — or "Rows 26–50 of 137" when the server gives a total. */
  rowLabel: string;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  pageSize?: number;
  onPageSizeChange?: (size: number) => void;
  pageSizeOptions?: readonly number[];
  disabled?: boolean;
  className?: string;
};

export function Pagination({
  rowLabel,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  pageSize,
  onPageSizeChange,
  pageSizeOptions = [25, 50, 100],
  disabled = false,
  className,
}: PaginationProps) {
  return (
    <nav
      aria-label="Pagination"
      className={cn(
        'flex flex-col-reverse items-stretch justify-between gap-3 sm:flex-row sm:items-center',
        className,
      )}
    >
      <p aria-live="polite" className="text-xs text-secondary tabular">
        {rowLabel}
      </p>

      <div className="flex items-center gap-2">
        {pageSize && onPageSizeChange ? (
          <label className="flex items-center gap-2 text-xs text-secondary">
            <span>Rows</span>
            <select
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              className="h-8 rounded-control border border-control bg-elevated px-2 text-xs text-primary"
            >
              {pageSizeOptions.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <Button
          variant="outline"
          size="sm"
          onClick={onPrevious}
          disabled={disabled || !hasPrevious}
          title={hasPrevious ? 'Previous rows' : 'Already at the first page'}
        >
          <ChevronLeft className="size-3.5" aria-hidden="true" />
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onNext}
          disabled={disabled || !hasNext}
          title={hasNext ? 'Next rows' : 'No further rows'}
        >
          Next
          <ChevronRight className="size-3.5" aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}
