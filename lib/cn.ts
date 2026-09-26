import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge conditional class names and resolve Tailwind conflicts.
 *
 * The `twMerge` step matters: without it `cn('p-2', 'p-4')` silently keeps
 * both, and the later one wins by accident of stylesheet order rather than
 * intent. docs/31_CODING_STANDARDS.md §"Naming conventions".
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
