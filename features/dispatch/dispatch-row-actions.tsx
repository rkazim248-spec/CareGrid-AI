'use client';

import * as React from 'react';
import { CircleSlash } from 'lucide-react';
import { toast } from 'sonner';

import {
  Alert,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Progress,
  Textarea,
} from '@/components/ui';
import { REPORT_LIMITS } from '@/config';
import { formatCountdown } from '@/lib/format';
import type { Dispatch } from '@/types';

/**
 * The responder's own actions on one assignment (docs/04 §13.12, §14.5).
 *
 * Split out of the ledger because this is where the two highest-stakes
 * interactions on the route live, and both deserve to be readable on their own:
 *
 *  - `Accept` is 56 px on mobile, because it is a decision made one-handed,
 *    possibly in gloves, in daylight. The 120 s window is a `Progress` bar, not
 *    text that reflows as it counts down.
 *  - `Withdraw` is `danger-outline` and ALWAYS opens a reason dialog. A
 *    withdrawal tells someone who may already be travelling to stand down; it is
 *    not a button you can press by accident, and the reason is what makes it
 *    auditable (docs/04 §14.5, anti-pattern A11).
 *
 * Both actions toast and change nothing. Phase 1 has no API (docs/04 §9.8).
 */

const WITHDRAW_REASON_LABEL = 'Why is this assignment being withdrawn?';
const WITHDRAW_PLACEHOLDER =
  'e.g. a responder with the right capability was closer';

export function DispatchRowActions({
  dispatch,
  onWithdraw,
  mobile = false,
}: {
  dispatch: Dispatch;
  onWithdraw: (dispatch: Dispatch) => void;
  mobile?: boolean;
}) {
  if (dispatch.status === 'accepted' || dispatch.status === 'active') {
    return (
      <div className="flex flex-col gap-2">
        {dispatch.status === 'active' ? <ExpiryBar dispatch={dispatch} /> : null}
        <Button
          variant="primary"
          size={mobile ? 'xl' : 'sm'}
          className={mobile ? 'w-full min-h-14' : 'min-h-11'}
          onClick={() =>
            toast.success('Assignment accepted.', {
              description: `Demo build — nothing was sent. ${dispatch.incidentReference} is now yours.`,
            })
          }
        >
          Accept
        </Button>
        <Button
          variant="danger-outline"
          size={mobile ? 'lg' : 'sm'}
          className={mobile ? 'w-full min-h-12' : 'min-h-11'}
          onClick={() => onWithdraw(dispatch)}
        >
          <CircleSlash aria-hidden="true" />
          Withdraw
        </Button>
      </div>
    );
  }

  return (
    <p className="text-xs text-muted">{CLOSED_REASON[dispatch.status] ?? 'This assignment is closed.'}</p>
  );
}

const CLOSED_REASON: Partial<Record<Dispatch['status'], string>> = {
  withdrawn: 'This assignment was withdrawn. Nothing further is needed.',
  expired: 'This assignment expired and was withdrawn. Nothing further is needed.',
  completed: 'This assignment is complete. Nothing further is needed.',
};

/**
 * The 120 s accept window as a bar. The interval is cleared on unmount — a timer
 * that outlives its component is how a stale countdown ends up on screen forever.
 */
function ExpiryBar({ dispatch }: { dispatch: Dispatch }) {
  const expiresAtMs = Date.parse(dispatch.expiresAt);
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const windowSec = REPORT_LIMITS.dispatchExpirySec;
  const remaining = Math.max(0, Math.round((expiresAtMs - now) / 1000));
  const ratio = Math.min(1, remaining / windowSec);
  const countdown = formatCountdown(remaining);

  return (
    <div className="flex flex-col gap-1">
      <Progress
        value={ratio}
        label={`${countdown} left to respond`}
        fillClassName={remaining <= 20 ? 'bg-danger' : 'bg-accent'}
      />
      <p className="text-xs text-muted tabular">Respond within {countdown}</p>
    </div>
  );
}

/** Withdraw always requires a reason. Typed, validated, then discarded. */
export function WithdrawDialog({
  dispatch,
  onOpenChange,
}: {
  dispatch: Dispatch | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [reason, setReason] = React.useState('');
  const [touched, setTouched] = React.useState(false);

  if (!dispatch) return null;

  const tooShort = reason.trim().length < REPORT_LIMITS.reasonMinChars;
  const error =
    touched && tooShort ? `Write at least ${REPORT_LIMITS.reasonMinChars} characters.` : undefined;

  const submit = () => {
    setTouched(true);
    if (tooShort) return;
    toast.success('Assignment withdrawn.', {
      description: `Demo build — nothing was sent. Reason recorded: “${reason.trim()}”.`,
    });
    setReason('');
    setTouched(false);
    onOpenChange(false);
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Withdraw this assignment?</DialogTitle>
          <DialogDescription>
            {dispatch.incidentReference} is assigned to {dispatch.responder.displayName}. The reason
            is recorded in the audit log with your name.
          </DialogDescription>
        </DialogHeader>

        <Alert tone="warning">
          <AlertIcon tone="warning" />
          <div>
            <AlertTitle>Someone may already be travelling</AlertTitle>
            <AlertDescription>
              Withdrawing tells the responder to stand down. If they are on the way, they will see
              it.
            </AlertDescription>
          </div>
        </Alert>

        <Textarea
          label={WITHDRAW_REASON_LABEL}
          required
          rows={4}
          maxChars={REPORT_LIMITS.reasonMaxChars}
          showCount
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          errorMessage={error}
          placeholder={WITHDRAW_PLACEHOLDER}
        />

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Keep the assignment
          </Button>
          <Button variant="danger-outline" onClick={submit}>
            Withdraw assignment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
