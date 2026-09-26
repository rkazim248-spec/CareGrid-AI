/**
 * Report form copy — docs/04_UI_UX_DESIGN_SPECIFICATION.md §13.2, §14.1, §14.3,
 * §15.5.
 *
 * Tone rules that are not negotiable here (docs/04 §15):
 *  - no exclamation marks (A4)
 *  - no "successfully"
 *  - the AI is advisory, never the actor
 *  - a location is never described more precisely than it is (A5)
 *  - the demo disclaimer is visible ON the form, not in a footer (US-042)
 */

export const REPORT_COPY = {
  /** The honest note at the top of the form. Phase 1 sends nothing. */
  phaseNotice:
    'This is the Phase 1 UI shell. Submitting does not send anything — no backend, AI, or storage is connected yet.',

  whatIsHappeningTitle: 'What is happening',
  whatIsHappeningHelper: '20 characters minimum. Describe it in your own words.',
  whatIsHappeningPlaceholder: 'For example: a car has crashed on the service road near the metro gate',

  photosTitle: 'Add photos',
  photosLead: 'Up to 3 photos, 5 MB each. A photo helps a responder find the place.',
  photosHelper: 'Simulated slots in this build. Nothing is uploaded and no file is read.',
  addPhotoLabel: 'Add photo',

  voiceTitle: 'Record a voice note',
  voiceLead: 'Up to one clip, two minutes long.',
  voiceStateTitle: 'P1 — voice is not enabled in this build',
  voiceStateBody:
    'Recording needs a media pipeline that is not connected yet. A photo or a written description works in this build.',
  voiceElapsedLabel: 'Elapsed',
  voiceRecordLabel: 'Start recording',
  voiceDisabledReason:
    'Voice is not enabled in this build. Add a photo or a written description instead.',

  locationTitle: 'Location',
  locationLead:
    'Add your location so responders can find this. You can also drop a pin, type an address, or continue without one.',
  useCurrentLocation: 'Use my current location',
  fallbackTitle: 'Other ways to add a location',
  fallbackNone:
    'Pick one of the options below, or continue without a location. A report with no location is still accepted.',
  fallbackPin: 'Drop a pin',
  fallbackAddress: 'Type an address',
  fallbackSkip: 'Continue without location',
  fallbackPinNote: 'A pin picker is not connected in this build. The choice is recorded for the flow only.',
  fallbackAddressNote: 'Address lookup is not connected in this build. The choice is recorded for the flow only.',
  fallbackSkipNote: 'A report with no location is still accepted. A dispatcher will ask the reporter for details.',

  privacyAlertTitle: 'Who can see this report',
  privacyAlertBody:
    'Dispatchers and the assigned responder can see this report. Responders cannot see your name.',

  categoryTitle: 'Category',
  categoryLead: 'Optional. CareGrid AI will suggest one and a dispatcher confirms it.',

  reviewTitle: 'Review your report',

  submitLabel: 'Submit Emergency Report',
  submitDisabledReason:
    'Tell us a little more — 20 characters minimum, or add a photo or a voice note.',
  submitting: 'Sending your report. This usually takes under 10 seconds.',

  nextTitle: 'What happens next',
  nextBody:
    'The report is triaged, a dispatcher reads it, and a verified community responder is assigned. You get a reference you can use to follow it.',

  referenceLabel: 'Your reference',
  copyReference: 'Copy reference',
  copied: 'Reference copied',
  share: 'Share',
  trackLink: 'Track this report',

  successTitle: 'Report received',
  successBody:
    'Your report is with the triage team. Keep this reference — you can check progress with it at any time.',
} as const;

/** docs/04 §14.1 `report.success`. Reused by the success screen. */
export const DEMO_REFERENCE = 'CG-7QK4M2';
