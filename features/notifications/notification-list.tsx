'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { BellOff, CheckCheck } from 'lucide-react';

import {
  Button,
  Pagination,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import { DemoDataBadge, EMPTY_COPY, EmptyState } from '@/components/feedback';
import { MOCK_NOTIFICATIONS } from '@/lib/mock-data';
import { formatDayHeading } from '@/lib/format';
import { NotificationRow } from '@/features/notifications/notification-row';
import type { AppNotification, NotificationType } from '@/types';

/**
 * /notifications — docs/04 §13.14.
 *
 * URL-backed filter tabs (`?filter=all|unread|assigned`) for the same reason
 * the settings tabs are: a filter that changes what you are looking at is a
 * navigation (docs/04 §5.15, §5.32).
 *
 * Read state is local. `PATCH /api/notifications/read-all` is the Phase 3 call;
 * the shape of the interaction, the button, and the row treatment are the parts
 * worth reviewing now.
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

const ASSIGNED_TYPES: readonly NotificationType[] = ['incident_assigned'];

export function NotificationList() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const requested = searchParams.get('filter');
  const filter: FilterValue = isFilterValue(requested) ? requested : 'all';

  // `null` means "read, as delivered". Phase 3 replaces this with the payload.
  const [readOverrides, setReadOverrides] = React.useState<Record<string, boolean>>({});
  const [page, setPage] = React.useState(0);

  const setFilter = React.useCallback(
    (value: string) => {
      if (!isFilterValue(value)) return;
      setPage(0);
      router.replace(`/notifications?filter=${value}`, { scroll: false });
    },
    [router],
  );

  const items = React.useMemo<readonly AppNotification[]>(
    () =>
      MOCK_NOTIFICATIONS.map((entry) => {
        const override = readOverrides[entry.notificationId];
        return override === undefined ? entry : { ...entry, read: override };
      }),
    [readOverrides],
  );

  const visible = React.useMemo(() => {
    if (filter === 'unread') return items.filter((entry) => !entry.read);
    if (filter === 'assigned') return items.filter((entry) => ASSIGNED_TYPES.includes(entry.type));
    return items;
  }, [items, filter]);

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const window = visible.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const unreadCount = items.filter((entry) => !entry.read).length;
  const from = visible.length === 0 ? 0 : safePage * PAGE_SIZE + 1;
  const to = Math.min(safePage * PAGE_SIZE + PAGE_SIZE, visible.length);

  const markAllRead = () => {
    setReadOverrides(
      Object.fromEntries(MOCK_NOTIFICATIONS.map((entry) => [entry.notificationId, true])),
    );
  };

  const markOneRead = (id: string) => {
    setReadOverrides((current) => ({ ...current, [id]: true }));
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <DemoDataBadge />
        {unreadCount > 0 ? (
          <span className="text-xs text-secondary tabular">
            {unreadCount} unread of {items.length}
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
          disabled={unreadCount === 0}
        >
          <CheckCheck aria-hidden="true" />
          Mark all as read
        </Button>
      </div>

      {window.length === 0 ? (
        <EmptyState
          icon={BellOff}
          title={EMPTY_COPY.notifications.title}
          description={EMPTY_COPY.notifications.description}
        />
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
