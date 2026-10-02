/**
 * /track copy — docs/04_UI_UX_DESIGN_SPECIFICATION.md §13.3, §14.
 *
 * The "what happens next" sentence is NOT written here. It comes from
 * `STATUS_META[status].citizenNext`, which is the single reviewed table for all
 * eleven statuses, so this screen can never drift from the status a citizen is
 * actually shown elsewhere (docs/04 §6, §13.3 timeline copy table).
 */

export const TRACK_COPY = {
  title: 'Track a report',
  description:
    'Follow the progress of a report you made with the reference you were given.',
  referenceLabel: 'Reference',
  referenceHelper: 'Enter the reference shown on a saved incident. Case does not matter.',
  lookUp: 'Look up',

  summaryLabel: 'What was reported',
  lastUpdateLabel: 'Last update',
  whatNextTitle: 'What happens next',
  progressTitle: 'Progress',
  progressLead: 'Each step shows when it happened. A step with no time has not been reached yet.',
  timelineTitle: 'History',
  timelineLead: 'Everything that has happened to this report, in plain language.',

  addPhoto: 'Add a photo',
  cancelReport: 'Cancel report',
  cancelAllowed: 'You can cancel this report until a responder is assigned.',
  cancelBlocked:
    'This report has moved past the point where it can be cancelled. Ask a dispatcher if it should be closed.',
  photoWindowClosed: 'Photos can be added within two hours of a report. This one is older than that.',
} as const;
