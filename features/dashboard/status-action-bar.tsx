'use client';

import * as React from 'react';
import { BadgeCheck, CircleSlash, Link2, UserPlus } from 'lucide-react';
import { toast } from 'sonner';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Textarea,
} from '@/components/ui';
import { REPORT_LIMITS } from '@/config';
import type { Incident } from '@/types';

/**
 * StatusActionBar — docs/04 §12.3 item 4, §13.9, §14.6.
 *
 * One primary, one secondary, one danger-outline, one outline. That is the whole
 * action set for a selected incident, and it is deliberately small: FR-073 asks
 * for "one click to the most common actions", and an operations console with
 * nine buttons in a row is a console where none of them get read.
 *
 * "Mark as a false alarm" opens a ConfirmDialog with a REQUIRED reason
 * (anti-pattern A11, FR-063/FR-133). The reason is typed and validated here and
 * then discarded: Phase 1 sends nothing. The pattern exists so that when the
 * server call lands, the audit trail is not a retrofit.
 */
export function StatusActionBar({
  incident,
  onVerify,
  onOpenAssign,
  onLinkReport,
  className,
}: {
  incident: Incident;
  /** The host owns the local verified flag; the bar only reports the intent. */
  onVerify?: () => void;
  onOpenAssign: () => void;
  /** Provided by the caller so the panel can also close over its own dialog. */
  onLinkReport: () => void;
  className?: string;
}) {
  const [falseAlarmOpen, setFalseAlarmOpen] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [touched, setTouched] = React.useState(false);

  const reasonError =
    touched && reason.trim().length < REPORT_LIMITS.reasonMinChars
      ? `Write at least ${REPORT_LIMITS.reasonMinChars} characters. This is recorded in the audit log.`
      : undefined;

  const verify = () => {
    onVerify?.();
    toast.success(`${incident.reference} verified.`, {
      description:
        'Demo build — nothing was sent. A person has confirmed this report; un-verifying is not possible.',
    });
  };

  const submitFalseAlarm = () => {
    setTouched(true);
    if (reason.trim().length < REPORT_LIMITS.reasonMinChars) return;
    toast.success('Marked as a false alarm.', {
      description: `Demo build — nothing was sent. Reason recorded: “${reason.trim()}”.`,
    });
    setReason('');
    setTouched(false);
    setFalseAlarmOpen(false);
  };

  return (
    <div className={className}>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button variant="primary" onClick={verify} className="w-full min-h-11 sm:w-auto">
          <BadgeCheck aria-hidden="true" />
          Verify
        </Button>
        <Button variant="secondary" onClick={onOpenAssign} className="w-full min-h-11 sm:w-auto">
          <UserPlus aria-hidden="true" />
          Assign responder
        </Button>
        <Button
          variant="danger-outline"
          onClick={() => {
            setTouched(false);
            setFalseAlarmOpen(true);
          }}
          className="w-full min-h-11 sm:w-auto"
        >
          <CircleSlash aria-hidden="true" />
          False alarm
        </Button>
        <Button variant="outline" onClick={onLinkReport} className="w-full min-h-11 sm:w-auto">
          <Link2 aria-hidden="true" />
          Link report
        </Button>
      </div>

      <ConfirmFalseAlarm
        open={falseAlarmOpen}
        onOpenChange={setFalseAlarmOpen}
        reference={incident.reference}
        reason={reason}
        onReasonChange={setReason}
        error={reasonError}
        onSubmit={submitFalseAlarm}
      />
    </div>
  );
}

/** The ConfirmDialog pattern (docs/04 §5.13) with the reason field above the actions. */
function ConfirmFalseAlarm({
  open,
  onOpenChange,
  reference,
  reason,
  onReasonChange,
  error,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reference: string;
  reason: string;
  onReasonChange: (value: string) => void;
  error: string | undefined;
  onSubmit: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Mark as a false alarm?</DialogTitle>
          <DialogDescription>
            This records who marked {reference} and why. It cannot be undone from this screen.
          </DialogDescription>
        </DialogHeader>

        <Textarea
          label="Why is this a false alarm?"
          required
          rows={4}
          maxChars={REPORT_LIMITS.reasonMaxChars}
          showCount
          value={reason}
          onChange={(event) => onReasonChange(event.target.value)}
          errorMessage={error}
          placeholder="e.g. prank call, wrong street, no incident at the location"
          helperText="Recorded against your name in the audit log."
        />

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Keep the incident
          </Button>
          <Button variant="danger-outline" onClick={onSubmit}>
            Mark as false alarm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
