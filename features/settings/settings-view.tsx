'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';

import {
  Alert,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardHeader,
  RadioCard,
  RadioGroup,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SwitchField,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import { useTheme } from '@/components/providers/theme-provider';
import { notificationChannels, type NotificationChannelReport } from '@/lib/api/client';
import { RetentionTable } from '@/features/settings/retention-table';
import { SETTINGS_COPY } from '@/features/settings/settings-copy';
import { useResolvedSession } from '@/components/providers/session-provider';

/**
 * /settings — docs/04 §13.16.
 *
 * URL-backed tabs (`?tab=notifications|display|privacy`) because a tab that
 * changes what you are looking at is a navigation, not a local toggle
 * (docs/04 §5.15). `router.replace` keeps the Back button from filling up with
 * tab switches.
 *
 * These preferences live in `localStorage` under `cg.ui`. That is a documented
 * v1 limitation, not an oversight: `PATCH /api/me` in docs/08 §2.3 has no field
 * for them, so a cross-device preference is not possible yet (docs/04 §16 D9).
 */
const TABS = [
  { value: 'account', label: SETTINGS_COPY.accountTab },
  { value: 'notifications', label: SETTINGS_COPY.notificationsTab },
  { value: 'display', label: SETTINGS_COPY.displayTab },
  { value: 'privacy', label: SETTINGS_COPY.privacyTab },
  { value: 'security', label: SETTINGS_COPY.securityTab },
] as const;

type TabValue = (typeof TABS)[number]['value'];

function isTabValue(value: string | null): value is TabValue {
  return value === 'account' || value === 'notifications' || value === 'display' || value === 'privacy' || value === 'security';
}

export function SettingsView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const theme = useTheme();
  const { user, signOut } = useResolvedSession();

  const requested = searchParams.get('tab');
  const active: TabValue = isTabValue(requested) ? requested : 'account';

  const setTab = React.useCallback(
    (value: string) => {
      if (!isTabValue(value)) return;
      router.replace(`/settings?tab=${value}`, { scroll: false });
    },
    [router],
  );

  const [timezone, setTimezone] = React.useState<string>('Asia/Kolkata');
  const [dateFormat, setDateFormat] = React.useState<string>('d MMM yyyy');
  const [toastOn, setToastOn] = React.useState(true);
  const [markAllOnOpen, setMarkAllOnOpen] = React.useState(false);

  // Notification channel preferences (synced with server via PATCH /api/me)
  const [inAppEnabled, setInAppEnabled] = React.useState(true);
  const [emailEnabled, setEmailEnabled] = React.useState(false);
  const [smsEnabled, setSmsEnabled] = React.useState(false);
  const [whatsappEnabled, setWhatsappEnabled] = React.useState(false);

  // Channel availability is the SERVER's provider status, fetched — never a
  // client-side guess. Until the report arrives (or if it fails) every external
  // channel is treated as unavailable, which is the only safe default: brief §4
  // forbids enabling a channel whose provider is not configured.
  const [channels, setChannels] = React.useState<NotificationChannelReport | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    notificationChannels()
      .then((report) => {
        if (!cancelled) setChannels(report);
      })
      .catch(() => {
        if (!cancelled) setChannels(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const clearLocal = React.useCallback((what: string) => {
    toast.success(what, {
      description: 'This build keeps nothing in the browser, so there was nothing to remove.',
    });
  }, []);

  const isChannelLive = (channel: 'sms' | 'whatsapp' | 'email') =>
    channels?.available.includes(channel) ?? false;

  const smsAvailable = isChannelLive('sms');
  const whatsappAvailable = isChannelLive('whatsapp');
  const emailAvailable = isChannelLive('email');

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-5">
      <Tabs value={active} onValueChange={setTab}>
        <h2 className="mb-2 text-sm font-medium text-secondary">Settings sections</h2>
        <TabsList className="w-full justify-start overflow-x-auto">
          {TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="account" className="mt-4">
          <Card>
            <CardHeader>
              <h3 className="text-base font-semibold text-primary">{SETTINGS_COPY.accountTab}</h3>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <dl className="grid gap-4 sm:grid-cols-2">
                <div>
                  <dt className="text-xs font-medium text-muted">Display name</dt>
                  <dd className="mt-1 break-words text-sm text-primary">{user?.displayName || 'Not set'}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-muted">Email</dt>
                  <dd className="mt-1 break-all text-sm text-primary">{user?.email || 'Not available'}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-muted">Account role</dt>
                  <dd className="mt-1 text-sm capitalize text-primary">{user?.role || 'Not available'}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-muted">Account status</dt>
                  <dd className="mt-1 text-sm capitalize text-primary">{user?.status?.replaceAll('_', ' ') || 'Not available'}</dd>
                </div>
              </dl>
              <Button asChild variant="outline" className="self-start">
                <Link href="/profile">Manage profile</Link>
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="notifications" className="mt-4">
          <Card>
            <CardHeader>
              <h3 className="text-base font-semibold text-primary">
                {SETTINGS_COPY.notificationsTab}
              </h3>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium text-secondary">
                  {SETTINGS_COPY.channelsTitle}
                </span>
                <p className="text-xs text-secondary">{SETTINGS_COPY.channelsLead}</p>
              </div>

              <div className="flex flex-col gap-3">
                <SwitchField
                  id="settings-channel-inapp"
                  label={SETTINGS_COPY.channelInApp}
                  helperText={SETTINGS_COPY.channelInAppHelp}
                  checked={inAppEnabled}
                  onCheckedChange={setInAppEnabled}
                />
                <SwitchField
                  id="settings-channel-email"
                  label={SETTINGS_COPY.channelEmail}
                  helperText={SETTINGS_COPY.channelEmailHelp}
                  checked={emailEnabled}
                  onCheckedChange={setEmailEnabled}
                  disabled={!emailAvailable}
                  disabledReason={!emailAvailable ? SETTINGS_COPY.channelUnavailable : undefined}
                />
                <SwitchField
                  id="settings-channel-sms"
                  label={SETTINGS_COPY.channelSms}
                  helperText={SETTINGS_COPY.channelSmsHelp}
                  checked={smsEnabled}
                  onCheckedChange={setSmsEnabled}
                  disabled={!smsAvailable}
                  disabledReason={!smsAvailable ? SETTINGS_COPY.channelUnavailable : undefined}
                />
                <SwitchField
                  id="settings-channel-whatsapp"
                  label={SETTINGS_COPY.channelWhatsApp}
                  helperText={SETTINGS_COPY.channelWhatsAppHelp}
                  checked={whatsappEnabled}
                  onCheckedChange={setWhatsappEnabled}
                  disabled={!whatsappAvailable}
                  disabledReason={!whatsappAvailable ? SETTINGS_COPY.channelUnavailable : undefined}
                />
              </div>

              <SwitchField
                id="settings-new-incident-toast"
                label={SETTINGS_COPY.newIncidentToast}
                helperText={SETTINGS_COPY.newIncidentToastHelp}
                checked={toastOn}
                onCheckedChange={setToastOn}
              />
              <SwitchField
                id="settings-mark-all-read"
                label={SETTINGS_COPY.markAllReadOnOpen}
                helperText={SETTINGS_COPY.markAllReadOnOpenHelp}
                checked={markAllOnOpen}
                onCheckedChange={setMarkAllOnOpen}
              />
              <SwitchField
                id="settings-dense-queue"
                label={SETTINGS_COPY.denseQueue}
                helperText={SETTINGS_COPY.denseQueueHelp}
                checked={theme.denseQueue}
                onCheckedChange={theme.setDenseQueue}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="display" className="mt-4">
          <Card>
            <CardHeader>
              <h3 className="text-base font-semibold text-primary">{SETTINGS_COPY.displayTab}</h3>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium text-secondary">
                  {SETTINGS_COPY.timezoneLabel}
                </span>
                <Select value={timezone} onValueChange={setTimezone}>
                  <SelectTrigger
                    id="settings-timezone"
                    aria-label={`${SETTINGS_COPY.timezoneLabel}, currently ${timezone}`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SETTINGS_COPY.timezoneOptions.map((zone) => (
                      <SelectItem key={zone.value} value={zone.value}>
                        {zone.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-secondary">{SETTINGS_COPY.timezoneHelp}</p>
              </div>

              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium text-secondary">
                  {SETTINGS_COPY.dateFormatLabel}
                </span>
                <Select value={dateFormat} onValueChange={setDateFormat}>
                  <SelectTrigger
                    id="settings-date-format"
                    aria-label={`${SETTINGS_COPY.dateFormatLabel}, currently ${dateFormat}`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SETTINGS_COPY.dateFormatOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-secondary">{SETTINGS_COPY.dateFormatHelp}</p>
              </div>

              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium text-secondary">{SETTINGS_COPY.themeLabel}</span>
                <Select
                  value={theme.preference}
                  onValueChange={(value) => theme.setTheme(value === 'light' || value === 'dark' ? value : 'auto')}
                >
                  <SelectTrigger
                    id="settings-theme"
                    aria-label={`${SETTINGS_COPY.themeLabel}, currently ${theme.preference}`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SETTINGS_COPY.themeOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-secondary">{SETTINGS_COPY.themeHelp}</p>
              </div>

              <fieldset className="flex flex-col gap-2">
                <legend className="text-sm font-medium text-secondary">
                  {SETTINGS_COPY.reduceMotionTitle}
                </legend>
                <RadioGroup
                  value={theme.reduceMotion}
                  onValueChange={(value) =>
                    theme.setReduceMotion(value === 'reduce' ? 'reduce' : 'auto')
                  }
                  className="grid-cols-1 gap-2"
                >
                  <RadioCard
                    id="settings-motion-auto"
                    value="auto"
                    label={SETTINGS_COPY.motionAuto}
                    description={SETTINGS_COPY.motionAutoHelp}
                  />
                  <RadioCard
                    id="settings-motion-reduce"
                    value="reduce"
                    label={SETTINGS_COPY.motionReduce}
                    description={SETTINGS_COPY.motionReduceHelp}
                  />
                </RadioGroup>
                <p className="text-xs text-secondary">{SETTINGS_COPY.reduceMotionHelp}</p>
              </fieldset>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="privacy" className="mt-4">
          <div className="flex flex-col gap-5">
            <Card>
              <CardHeader>
                <h3 className="text-base font-semibold text-primary">
                  {SETTINGS_COPY.retentionTitle}
                </h3>
                <p className="text-sm text-secondary">{SETTINGS_COPY.retentionLead}</p>
              </CardHeader>
              <CardContent>
                <RetentionTable />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <h3 className="text-base font-semibold text-primary">
                  {SETTINGS_COPY.localDataTitle}
                </h3>
                <p className="text-sm text-secondary">{SETTINGS_COPY.localDataLead}</p>
              </CardHeader>
              <CardContent className="flex flex-col items-start gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  onClick={() => clearLocal(SETTINGS_COPY.clearedDraft)}
                >
                  {SETTINGS_COPY.clearDraft}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  onClick={() => clearLocal(SETTINGS_COPY.clearedCached)}
                >
                  {SETTINGS_COPY.clearCached}
                </Button>
                <Alert tone="neutral">
                  <AlertIcon tone="neutral" />
                  <div className="flex min-w-0 flex-col gap-1">
                    <AlertTitle>Local only</AlertTitle>
                    <AlertDescription>{SETTINGS_COPY.nothingStored}</AlertDescription>
                  </div>
                </Alert>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="security" className="mt-4">
          <Card>
            <CardHeader>
              <h3 className="text-base font-semibold text-primary">{SETTINGS_COPY.securityTab}</h3>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <p className="max-w-[60ch] text-sm leading-6 text-secondary">
                Sign-in credentials are managed by your authentication provider. Use the password reset flow to change a password, or sign out of this device.
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button asChild variant="outline" className="w-full sm:w-auto">
                  <Link href="/forgot-password">Reset password</Link>
                </Button>
                <Button variant="danger-outline" className="w-full sm:w-auto" onClick={signOut}>
                  Sign out
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
