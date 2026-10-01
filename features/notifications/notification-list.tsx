'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { BellOff, CheckCheck } from 'lucide-react';
import { toast } from 'sonner';

import {
  Alert,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Button,
  Pagination,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import { EMPTY_COPY, EmptyState } from '@/components/feedback';
import { notificationMarkAllRead, notificationMarkRead } from '@/lib/api/client';
import { messageFor } from '@/lib/api/errors';
import { formatDayHeading } from '@/lib/format';
import {
  useRealtimeNotifications,
  type LiveNotification,
} from '@/features/notifications/use-realtime-notifications';
import { NotificationRow } from '@/features/notifications/notification-row';
import type { AppNotification, NotificationType } from '@/types';

/**
 * /notifications — docs/04 §13.14.
 *
 * The list is LIVE (L5): a `onSnapshot` listener scoped to the signed-in
 * recipient, so a new dispatch notification or an incident update lands here
 * without a refresh. Read state is not local — marking read PATCHes
 * `/api/notifications`, the server scopes the write to the verified token, and
 * the snapshot flips the row.
 *
 * URL-backed filter tabs (`?filter=all|unread|assigned`) for the same reason
 * the settings tabs are: a filter that changes what you are looking at is a
 * navigation (docs/04 §5.15, §5.32).
 *
 * PAGE SIZE 10, not the 25 the API envelope defaults to: this is a phone list
 * and a person checking alerts wants them without scrolling past a screen of
 * history (docs/04 §13.14 mobile).
 */
const PAGE_SIZE = 10;

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
  { value: 'assigned', label: 'Assigned' },
] as const;

type FilterValue = (typeof FILTERS)[number]['value'];

function isFilterValue(value: string | null): value is FilterValue {
  return value === 'all' || value === 'unread' || value === 'assigned';
}

/** Notifications that mean "this is yours to answer", not just "something moved". */
const ASSIGNED_TYPES: readonly NotificationType[] = [
  'incident_assigned',
  'dispatch_received',
];

/** A row whose timestamp could not be read still renders — under the epoch heading rather than being dropped. */
const EPOCH_ISO = new Date(0).toISOString();

/**
 * `LiveNotification` → `AppNotification`.
 *
 * The listener row is a subset of the stored document; the row component's
 * contract is the domain type. `actor` is `null` because nothing the row
 * renders reads it, and echoing a server actor identity into the payload adds
 * nothing for this screen.
 */
function toAppNotification(live: LiveNotification): AppNotification {
  return {
    notificationId: live.id,
    type: live.type,
    severity: live.severity,
    title: live.title,
    body: live.body,
    incidentId: live.incidentId,
    link: live.link,
    read: live.read,
    createdAt: live.createdAtIso ?? EPOCH_ISO,
    actor: null,
  };
}

export function NotificationList() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const requested = searchParams.get('filter');
  const filter: FilterValue = isFilterValue(requested) ? requested : 'all';

  const [page, setPage] = React.useState(0);
  const [markingAll, setMarkingAll] = React.useState(false);

  const notifications = useRealtimeNotifications();
  const { items: liveItems, unreadCount, hasReceivedSnapshot, error } = notifications;

  const setFilter = React.useCallback(
    (value: string) => {
      if (!isFilterValue(value)) return;
      setPage(0);
      router.replace(`/notifications?filter=${value}`, { scroll: false });
    },
    [router],
  );

  const items = React.useMemo<readonly AppNotification[]>(
    () => liveItems.map(toAppNotification),
    [liveItems],
  );

  const visible = React.useMemo(() => {
    if (filter === 'unread') return items.filter((entry) => !entry.read);
    if (filter === 'assigned') return items.filter((entry) => ASSIGNED_TYPES.includes(entry.type));
    return items;
  }, [items, filter]);

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const window = visible.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const from = visible.length === 0 ? 0 : safePage * PAGE_SIZE + 1;
  const to = Math.min(safePage * PAGE_SIZE + PAGE_SIZE, visible.length);

  const markAllRead = React.useCallback(() => {
    if (markingAll) return;
    setMarkingAll(true);
    notificationMarkAllRead()
      .catch((cause: unknown) => {
        toast.error('Could not mark everything as read.', { description: messageFor(cause) });
      })
      .finally(() => setMarkingAll(false));
  }, [markingAll]);

  // Fire-and-forget: the row flips when the server commit reaches the snapshot,
  // which is the same moment the unread count drops. A failure is loud.
  const markOneRead = React.useCallback((id: string) => {
    notificationMarkRead(id).catch((cause: unknown) => {
      toast.error('Could not mark as read.', { description: messageFor(cause) });
    });
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {unreadCount > 0 ? (
          <span className="text-xs text-secondary tabular">
            {unreadCount} unread of the {items.length} most recent
          </span>
        ) : null}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={filter} onValueChange={setFilter}>
          <h2 className="mb-2 text-sm font-medium text-secondary">Filter notifications</h2>
          <TabsList variant="pill">
            {FILTERS.map((entry) => (
              <TabsTrigger key={entry.value} value={entry.value} variant="pill">
                {entry.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <Button
          type="button"
          variant="secondary"
          size="lg"
          onClick={markAllRead}
          loading={markingAll}
          disabled={unreadCount === 0}
        >
          <CheckCheck aria-hidden="true" />
          Mark all as read
        </Button>
      </div>

      {error !== null ? (
        <Alert tone="danger" role="alert">
          <AlertIcon tone="danger" />
          <div className="flex min-w-0 flex-col gap-1">
            <AlertTitle>Live updates are unavailable</AlertTitle>
            <AlertDescription>
              {error.retryable
                ? 'The connection dropped. The list will retry on its own.'
                : 'This list could not be loaded. Try reloading the page.'}
            </AlertDescription>
          </div>
        </Alert>
      ) : !hasReceivedSnapshot ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : window.length === 0 ? (
        filter === 'unread' && items.length > 0 ? (
          <EmptyState
            icon={CheckCheck}
            title="You're all caught up"
            description="No unread notifications in your recent history."
          />
        ) : (
          <EmptyState
            icon={BellOff}
            title={EMPTY_COPY.notifications.title}
            description={EMPTY_COPY.notifications.description}
          />
        )
      ) : (
        <div className="flex flex-col gap-4">
          {groupByDay(window).map((group) => (
            <section key={group.heading} className="flex flex-col gap-2">
              <h3 className="uppercase-label text-muted">{group.heading}</h3>
              <ul className="flex flex-col gap-2">
                {group.items.map((entry) => (
                  <NotificationRow key={entry.notificationId} notification={entry} onOpen={markOneRead} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <Pagination
        rowLabel={visible.length === 0 ? 'Rows 0' : `Rows ${from}–${to} of ${visible.length}`}
        hasPrevious={safePage > 0}
        hasNext={safePage < pageCount - 1}
        onPrevious={() => setPage(safePage - 1)}
        onNext={() => setPage(safePage + 1)}
      />
    </div>
  );
}

/** Day headings come from the shared formatter, never from ad-hoc date maths. */
function groupByDay(entries: readonly AppNotification[]): { heading: string; items: AppNotification[] }[] {
  const groups: { heading: string; items: AppNotification[] }[] = [];
  for (const entry of entries) {
    const heading = formatDayHeading(entry.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.heading === heading) {
      last.items.push(entry);
    } else {
      groups.push({ heading, items: [entry] });
    }
  }
  return groups;
}
