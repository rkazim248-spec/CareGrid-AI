'use client';

import * as React from 'react';
import { Search, X } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Input } from '@/components/ui/input';
import { IconButton } from '@/components/ui/icon-button';
import { REPORT_LIMITS } from '@/config/limits';

/**
 * SearchInput — docs/04 §5.33
 *
 * Leading search icon, `type="search"`, a clear button that only exists when
 * there is something to clear, and a 300ms debounce (FR-087) with the last
 * response winning. The caller aborts superseded requests.
 */
export type SearchInputProps = Omit<
  React.ComponentProps<typeof Input>,
  'type' | 'value' | 'onChange' | 'trailingSlot'
> & {
  value: string;
  onValueChange: (value: string) => void;
  /** Called after the debounce interval, with the debounced value. */
  onDebouncedChange?: (value: string) => void;
  debounceMs?: number;
  className?: string;
};

export function SearchInput({
  value,
  onValueChange,
  onDebouncedChange,
  debounceMs = REPORT_LIMITS.searchDebounceMs,
  label = 'Search',
  helperText,
  className,
  ...props
}: SearchInputProps) {
  React.useEffect(() => {
    if (!onDebouncedChange) return;
    const timer = setTimeout(() => onDebouncedChange(value), debounceMs);
    return () => clearTimeout(timer);
  }, [value, debounceMs, onDebouncedChange]);

  return (
    <Input
      type="search"
      label={label}
      value={value}
      maxLength={REPORT_LIMITS.searchMaxChars}
      onChange={(e) => onValueChange(e.target.value)}
      helperText={helperText}
      autoComplete="off"
      className={cn(
        // Native clear button duplicates ours.
        '[&::-webkit-search-cancel-button]:appearance-none',
        className,
      )}
      trailingSlot={
        value ? (
          <IconButton
            label="Clear search"
            icon={X}
            size="sm"
            onClick={() => onValueChange('')}
            className="min-h-8 min-w-8"
          />
        ) : (
          <Search className="size-4 text-muted" aria-hidden="true" />
        )
      }
      {...props}
    />
  );
}
