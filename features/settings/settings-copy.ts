/**
 * /settings copy and data — docs/04_UI_UX_DESIGN_SPECIFICATION.md §13.16.
 *
 * Two of these are honesty requirements rather than preferences:
 *  - "Reduce" motion can only ever make motion LESS (docs/04 §16.3).
 *  - The retention table states real periods, and the two clear buttons state
 *    that they are local-only (docs/04 §13.16 Retention copy, US-042 AC3).
 */

export const SETTINGS_COPY = {
  title: 'Settings',
  description:
    'Preferences for this account. Notifications and appearance are stored in this browser only.',

  notificationsTab: 'Notifications',
  displayTab: 'Display',
  privacyTab: 'Privacy',

  newIncidentToast: 'New incident toast',
  newIncidentToastHelp: 'Show a quiet banner when a new incident arrives. No sound is ever played.',
  markAllReadOnOpen: 'Mark all read when I open the list',
  markAllReadOnOpenHelp: 'Opening the notification list clears its unread count.',
  denseQueue: 'Dense queue rows',
  denseQueueHelp: 'Tighter rows in lists. Available in this build.',

  timezoneLabel: 'Timezone',
  timezoneHelp: 'Every timestamp in CareGrid AI is shown in this zone.',
  dateFormatLabel: 'Date format',
  dateFormatHelp: 'How a date is written in tables and history.',
  themeLabel: 'Theme',
  themeHelp: 'The light palette is measured and contrast-checked, and is available in this build.',

  reduceMotionTitle: 'Reduce motion',
  reduceMotionHelp: 'Auto follows your device setting. Reduce can only make motion less, never more.',
  motionAuto: 'Auto',
  motionAutoHelp: 'Follow the operating system setting.',
  motionReduce: 'Reduce',
  motionReduceHelp: 'Turn off transitions, slides, and shimmer in this browser.',

  retentionTitle: 'What is stored, and for how long',
  retentionLead:
    'These are the retention periods the platform is built to. An administrator can extend location retention, never shorten these.',
  localDataTitle: 'Local data',
  localDataLead:
    'Both actions below only clear data in THIS browser. Nothing is sent anywhere and nothing on a server changes.',
  clearDraft: 'Clear report draft',
  clearCached: 'Clear cached incident data',
  clearedDraft: 'Report draft cleared in this browser',
  clearedCached: 'Cached incident data cleared in this browser',
  nothingStored: 'There is nothing stored to clear in this build.',

  timezoneOptions: [
    { value: 'Asia/Kolkata', label: 'Asia/Kolkata (IST)' },
    { value: 'Asia/Dubai', label: 'Asia/Dubai (GST)' },
    { value: 'Europe/London', label: 'Europe/London (GMT/BST)' },
    { value: 'UTC', label: 'UTC' },
  ] as const,

  dateFormatOptions: [
    { value: 'd MMM yyyy', label: '26 Sep 2026' },
    { value: 'yyyy-MM-dd', label: '2026-09-26' },
    { value: 'MMM d, yyyy', label: 'Sep 26, 2026' },
  ] as const,

  themeOptions: [
    { value: 'auto', label: 'Auto', help: 'Follow the operating system setting.' },
    { value: 'light', label: 'Light', help: 'The measured light palette.' },
    { value: 'dark', label: 'Dark', help: 'The default operations theme.' },
  ] as const,
} as const;

/** The retention table. docs/07 §11.8, NFR-028. */
export const RETENTION_ROWS = [
  {
    item: 'Incident description and status',
    visibleTo: 'Dispatchers and administrators. Responders see the AI summary only.',
    retention: 'Retained while the incident is open, then archived.',
  },
  {
    item: 'Reporter name and contact details',
    visibleTo: 'Dispatchers and administrators. Never shown to responders.',
    retention: 'Retained with the incident record.',
  },
  {
    item: 'Location',
    visibleTo: 'Dispatchers, the assigned responder, and administrators.',
    retention: 'Purged 90 days after the incident closes, unless an administrator extends it.',
  },
  {
    item: 'Photos and voice notes',
    visibleTo: 'Dispatchers, the assigned responder, and administrators.',
    retention: 'Deleted 30 days after the reporter deletes them, or when the incident closes.',
  },
  {
    item: 'Audit log entries',
    visibleTo: 'Administrators. Dispatchers see a read-only view.',
    retention: 'Retained 365 days. Append-only: no role can change or remove an entry.',
  },
] as const;
