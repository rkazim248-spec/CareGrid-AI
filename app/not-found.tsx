import { NotFoundState } from '@/components/feedback';

/**
 * 404 for any unmatched path. The copy is identical whether the page does not
 * exist or exists for someone else — a different message for each would turn
 * this into an existence oracle (docs/04 §9.7, US-005 AC4).
 */
export default function NotFound() {
  return <NotFoundState variant="page" />;
}
