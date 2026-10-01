'use client';

import * as React from 'react';
import { toast } from 'sonner';

import { dispatchAccept, dispatchDecline } from '@/lib/api/client';
import { messageFor } from '@/lib/api/errors';

export type DispatchDecision = 'accept' | 'decline';

/**
 * The one accept/decline path shared by the alert dialog and the assignment
 * list, so both surfaces toast identically and cannot drift apart. The decline
 * reason is optional (docs/04 §16) and forwarded verbatim when present.
 *
 * The dispatcher is genuinely notified in-app by the server on both answers,
 * so the success copy makes no claim about SMS, WhatsApp or email.
 */
export function useDispatchResponse(onDone?: () => void) {
  const [pending, setPending] = React.useState(false);

  const respond = React.useCallback(
    async (decision: DispatchDecision, dispatchId: string, reason?: string) => {
      if (pending) return;
      setPending(true);
      try {
        const result =
          decision === 'accept'
            ? await dispatchAccept(dispatchId)
            : await dispatchDecline(dispatchId, reason ? { reason } : {});

        if (result.noop) {
          toast.info('Already handled.', {
            description:
              'This assignment was answered or expired before your response arrived.',
          });
        } else {
          toast.success(decision === 'accept' ? 'Assignment accepted.' : 'Assignment declined.', {
            description: 'The dispatcher will see your answer in their notifications.',
          });
        }
        onDone?.();
      } catch (error) {
        toast.error(decision === 'accept' ? 'Could not accept.' : 'Could not decline.', {
          description: messageFor(error),
        });
      } finally {
        setPending(false);
      }
    },
    [onDone, pending],
  );

  return { respond, pending };
}
