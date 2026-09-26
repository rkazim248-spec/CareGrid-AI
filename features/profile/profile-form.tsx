'use client';


import * as React from 'react';
import Link from 'next/link';
import { Lock } from 'lucide-react';
import { toast } from 'sonner';

import {
  Alert,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Avatar,
  Button,
  Card,
  CardContent,
  CardHeader,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  SwitchField,
} from '@/components/ui';
import { RoleBadge } from '@/components/domain';
import { ROLE_META } from '@/config';
import { AccountStatusBadge } from '@/features/profile/account-status-badge';
import { useResolvedSession } from '@/components/providers/session-provider';

/**
 * /profile — docs/04 §13.15.
 *
 * Centred, `max-w-[720px]`, one card for identity and one for preferences.
 *
 * Data minimisation is visible in the layout, not just the response: `role`,
 * `status`, and `email` are rendered read-only with a reason, because
 * `PATCH /api/me` in docs/08 §2.3 does not accept them at all. Offering an
 * editable field the server would reject is worse than not offering it.
 */
const TIMEZONES = [
  { value: 'Asia/Kolkata', label: 'Asia/Kolkata (IST)' },
  { value: 'Asia/Dubai', label: 'Asia/Dubai (GST)' },
  { value: 'Europe/London', label: 'Europe/London (GMT/BST)' },
  { value: 'UTC', label: 'UTC' },
] as const;

const LOCALES = [
  { value: 'en-IN', label: 'English (India)' },
  { value: 'en-GB', label: 'English (United Kingdom)' },
  { value: 'en-US', label: 'English (United States)' },
  { value: 'ar-AE', label: 'Arabic (United Arab Emirates)' },
] as const;

/** FR-105 / FR-106. The reason is rendered, not hidden in a tooltip. */
const NO_PROVIDER_REASON = 'No notification provider is configured in this deployment';

const SAVE_LATENCY_MS = 700;

export function ProfileForm() {

  const { user } = useResolvedSession();

  // Every value here comes from the SERVER-COMPUTED `/api/me` record, never
  // from a form field. `user` is null only if this is mounted outside the gate.
  const [displayName, setDisplayName] = React.useState(user?.displayName ?? '');
  const [timezone, setTimezone] = React.useState<string>('Asia/Kolkata');
  const [locale, setLocale] = React.useState<string>('en-IN');
  const [inApp, setInApp] = React.useState(true);
  const [emailPrefs, setEmailPrefs] = React.useState(true);
  const [saving, setSaving] = React.useState(false);

  const handleSave = React.useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setSaving(true);
      // Phase 1 has no API. The toast says what was saved so the control is
      // never a dead end (docs/04 §5.22).
      window.setTimeout(() => {
        setSaving(false);
        toast.success('Changes saved on this device', {
          description: 'No server is connected in this build, so nothing was sent.',
        });
      }, SAVE_LATENCY_MS);
    },
    [],
  );


  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-5">
      <Card>
        <CardHeader>
          <h2 className="uppercase-label text-muted">Account</h2>
        </CardHeader>
        <CardContent className="flex items-center gap-4">
          <Avatar name={user?.displayName ?? null} size="xl" />
          <div className="flex min-w-0 flex-col gap-1.5">
            <p className="text-lg font-semibold text-primary">{user?.displayName ?? ''}</p>
            <p className="flex items-center gap-1.5 text-sm text-secondary">
              <Lock className="size-3.5 shrink-0" aria-hidden="true" />
              {user?.email ?? ''}
            </p>
            <p className="text-xs text-muted">Managed by your sign-in provider</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <RoleBadge role={user?.role ?? 'citizen'} size="md" />
              <AccountStatusBadge status={user?.status ?? 'pending_verification'} />
            </div>
            <p className="mt-1 text-xs text-muted">
              Role: {ROLE_META[user?.role ?? 'citizen'].label}. Only an administrator can change it.
            </p>
          </div>
        </CardContent>
      </Card>

      <form noValidate onSubmit={handleSave}>
        <Card>
          <CardHeader>
            <h2 className="uppercase-label text-muted">Your details</h2>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <Input
              id="profile-display-name"
              label="Display name"
              className="h-12 md:h-10"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              autoComplete="name"
              helperText="Shown to dispatchers on incidents you file. Responders never see it."
              required
            />

            <div className="flex flex-col gap-2">
              <label htmlFor="profile-email-readonly" className="text-sm font-medium text-secondary">
                Email
              </label>
              <Input
                id="profile-email-readonly"
                value={user?.email ?? ''}
                readOnly
                disabled
                helperText="Managed by your sign-in provider. It cannot be edited here."
              />
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-secondary">Timezone</span>
              <Select value={timezone} onValueChange={setTimezone}>
                <SelectTrigger id="profile-timezone" aria-label={`Timezone, currently ${timezone}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIMEZONES.map((zone) => (
                    <SelectItem key={zone.value} value={zone.value}>
                      {zone.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-secondary">
                Every timestamp in CareGrid AI is shown in this zone.
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-secondary">Language and date format</span>
              <Select value={locale} onValueChange={setLocale}>
                <SelectTrigger id="profile-locale" aria-label={`Language, currently ${locale}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LOCALES.map((entry) => (
                    <SelectItem key={entry.value} value={entry.value}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Separator />

            <div className="flex flex-col">
              <h3 className="text-sm font-medium text-primary">Notification channels</h3>
              <SwitchField
                id="profile-notif-in-app"
                label="In app"
                helperText="A quiet banner inside CareGrid AI. No sound is ever played."
                checked={inApp}
                onCheckedChange={setInApp}
              />
              <SwitchField
                id="profile-notif-email"
                label="Email"
                helperText="Sent to the address managed by your sign-in provider."
                checked={emailPrefs}
                onCheckedChange={setEmailPrefs}
              />
              <SwitchField
                id="profile-notif-sms"
                label="SMS"
                helperText="Not available."
                disabled
                disabledReason={NO_PROVIDER_REASON}
                checked={false}
                onCheckedChange={() => undefined}
              />
              <SwitchField
                id="profile-notif-whatsapp"
                label="WhatsApp"
                helperText="Not available."
                disabled
                disabledReason={NO_PROVIDER_REASON}
                checked={false}
                onCheckedChange={() => undefined}
              />
            </div>

            <Alert tone="neutral">
              <AlertIcon tone="neutral" />
              <div className="flex min-w-0 flex-col gap-1">
                <AlertTitle>Who can see your reports</AlertTitle>
                <AlertDescription>
                  Dispatchers and administrators can see your reports. The assigned responder sees
                  the incident, not your identity.{' '}
                  <Link
                    href="/settings?tab=privacy"
                    className="inline-flex min-h-11 items-center text-accent underline-offset-4 hover:underline focus-visible:ring-[2px] focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app focus-visible:outline-none"
                  >
                    Privacy summary
                  </Link>
                </AlertDescription>
              </div>
            </Alert>

            <div className="flex flex-col items-start gap-1">
              <Button type="submit" variant="primary" size="lg" loading={saving}>
                Save changes
              </Button>
              <p className="text-xs text-muted">
                This build stores nothing on a server. The toast says so every time.
              </p>
            </div>
          </CardContent>
        </Card>
      </form>
    </div>
  );
}
