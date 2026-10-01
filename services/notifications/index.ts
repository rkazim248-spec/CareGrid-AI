/**
 * The notification surface for `brief` §1–§7.
 *
 * `server-only`: everything reachable from here touches the Admin SDK.
 *
 * Phase 7's `services/dispatch/notify.ts` still owns the dedupe transaction and the
 * recipient matrix; this module adds channel routing, delivery status and the retry
 * ceiling above it. The two are layered, not competing.
 */

import 'server-only';

export {
  availableChannelsNow,
  channelReport,
  deliverNotification,
  deliverToRecipients,
  isChannelAvailable,
  markAllRead,
  markRead,
  type DeliveryStatus,
  type DispatchOutcome,
  type NotificationChannelName,
  type UnifiedRecipient,
} from './dispatch';
