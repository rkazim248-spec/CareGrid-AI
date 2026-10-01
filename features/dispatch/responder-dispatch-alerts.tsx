'use client';

import * as React from 'react';

import { ResponderAlertDialog } from '@/features/dispatch/responder-alert-dialog';
import { useResponderDispatchAlert } from '@/features/dispatch/use-responder-dispatch-alert';

/**
 * Mount point for the live dispatch alert (Phase 13 brief §3). Rendering
 * nothing is the normal case: a responder with no unanswered dispatch sees no
 * alert, no overlay, no noise.
 *
 * A dispatch the responder dismissed stays dismissed for this visit — closing
 * the alert is "not now", not an answer. The assignment list still shows the
 * pending dispatch with its own accept/decline actions, so a dismissed alert is
 * never a lost one.
 */
export function ResponderDispatchAlerts() {
  const { alertDispatch, alertIncident } = useResponderDispatchAlert();
  const [dismissed, setDismissed] = React.useState<ReadonlySet<string>>(() => new Set());

  if (alertDispatch === null) return null;

  const open = !dismissed.has(alertDispatch.id);

  return (
    <ResponderAlertDialog
      dispatch={alertDispatch}
      incident={alertIncident}
      open={open}
      onClose={() =>
        setDismissed((current) => {
          const next = new Set(current);
          next.add(alertDispatch.id);
          return next;
        })
      }
    />
  );
}
