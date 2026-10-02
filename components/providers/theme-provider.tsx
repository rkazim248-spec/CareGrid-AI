'use client';

import * as React from 'react';

/**
 * Theme provider.
 *
 * The light palette is the default and follows the CareGrid brand system.
 * Dark and system-following themes remain available as local preferences.
 *
 * `auto` respects `prefers-color-scheme`; `reduce motion` is a separate,
 * independent preference and must only ever make motion LESS (docs/04 §16.3).
 *
 * The preference is stored in `localStorage` under `cg.ui`. It is a UI
 * preference, NOT account data: `PATCH /api/me` in docs/08 §2.3 has no theme
 * field, so a cross-device preference is not possible in v1. That is a
 * documented limitation, not an oversight.
 */

export type ThemePreference = 'auto' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'cg.ui';

type UiPreferences = {
  theme: ThemePreference;
  reduceMotion: 'auto' | 'reduce';
  denseQueue: boolean;
};

const DEFAULTS: UiPreferences = {
  theme: 'light',
  reduceMotion: 'auto',
  denseQueue: false,
};

type ThemeContextValue = {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  reduceMotion: 'auto' | 'reduce';
  systemReduceMotion: boolean;
  denseQueue: boolean;
  setTheme: (value: ThemePreference) => void;
  setReduceMotion: (value: 'auto' | 'reduce') => void;
  setDenseQueue: (value: boolean) => void;
  resetUiPreferences: () => void;
};

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

function readStoredPreferences(): UiPreferences {
  if (typeof window === 'undefined') return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULTS;
    const record = parsed as Partial<Record<keyof UiPreferences, unknown>>;
    return {
      theme:
        record.theme === 'light' || record.theme === 'dark' || record.theme === 'auto'
          ? record.theme
          : DEFAULTS.theme,
      reduceMotion: record.reduceMotion === 'reduce' ? 'reduce' : DEFAULTS.reduceMotion,
      denseQueue: typeof record.denseQueue === 'boolean' ? record.denseQueue : DEFAULTS.denseQueue,
    };
  } catch {
    // A corrupt preference must never brick the shell. Fall back silently.
    return DEFAULTS;
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preferences, setPreferences] = React.useState<UiPreferences>(DEFAULTS);
  const [systemTheme, setSystemTheme] = React.useState<ResolvedTheme>('light');
  const [systemReduceMotion, setSystemReduceMotion] = React.useState(false);

  // Read the persisted preference after mount, never during render: touching
  // localStorage during render breaks SSR hydration.
  React.useEffect(() => {
    setPreferences(readStoredPreferences());
  }, []);

  React.useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const update = () => setSystemTheme(media.matches ? 'light' : 'dark');
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  React.useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setSystemReduceMotion(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  const resolved: ResolvedTheme =
    preferences.theme === 'auto' ? systemTheme : preferences.theme;

  const shouldReduceMotion =
    preferences.reduceMotion === 'reduce' || systemReduceMotion;

  // Apply the scope class. `.light` re-points every custom property, so this is
  // a single class on <html> rather than a second stylesheet.
  React.useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('light', resolved === 'light');
  }, [resolved]);

  React.useEffect(() => {
    document.documentElement.dataset.reduceMotion = shouldReduceMotion ? 'true' : 'false';
  }, [shouldReduceMotion]);

  const persist = React.useCallback((next: UiPreferences) => {
    setPreferences(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Private-mode storage failures are not worth interrupting the user for.
    }
  }, []);

  const value = React.useMemo<ThemeContextValue>(
    () => ({
      preference: preferences.theme,
      resolved,
      reduceMotion: shouldReduceMotion ? 'reduce' : preferences.reduceMotion,
      systemReduceMotion,
      denseQueue: preferences.denseQueue,
      setTheme: (theme) => persist({ ...preferences, theme }),
      setReduceMotion: (reduceMotion) => persist({ ...preferences, reduceMotion }),
      setDenseQueue: (denseQueue) => persist({ ...preferences, denseQueue }),
      resetUiPreferences: () => persist(DEFAULTS),
    }),
    // `shouldReduceMotion` is derived from `preferences.reduceMotion` and
    // `systemReduceMotion`, both of which are already listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [preferences, resolved, systemReduceMotion, persist],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) {
    // Rendered outside the provider (e.g. an isolated component test) must
    // still get a usable, light-default context rather than throwing.
    return {
      preference: 'light',
      resolved: 'light',
      reduceMotion: 'auto',
      systemReduceMotion: false,
      denseQueue: false,
      setTheme: () => undefined,
      setReduceMotion: () => undefined,
      setDenseQueue: () => undefined,
      resetUiPreferences: () => undefined,
    };
  }
  return ctx;
}
