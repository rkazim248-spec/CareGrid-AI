/**
 * Numeric formatting. Every number a person acts on is tabular and rounded to
 * a number of significant figures a human can hold in their head.
 *
 * "18,204 incidents" in a control room is a number that cannot be used; "1.2 km"
 * and "4 min" are. docs/04 §3.3, §15.6.
 */

/** Distance. `640 m` under a kilometre, `2.1 km` above, `—` when unknown. */
export function formatDistance(metres: number | null | undefined): string {
  if (metres === null || metres === undefined || Number.isNaN(metres)) return '—';
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

/** Long-form distance for a screen-reader label. */
export function distanceAriaLabel(metres: number | null | undefined): string {
  if (metres === null || metres === undefined || Number.isNaN(metres)) {
    return 'Distance unknown';
  }
  return metres < 1000
    ? `${Math.round(metres)} metres away`
    : `${(metres / 1000).toFixed(1)} kilometres away`;
}

/** Duration from seconds. `47 s` · `3 min` · `1 h 12 m` · `2 d 4 h`. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  if (h < 24) return remM === 0 ? `${h} h` : `${h} h ${remM} m`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH === 0 ? `${d} d` : `${d} d ${remH} h`;
}

/**
 * SLA countdown copy. docs/04 §5.20.
 * `3 min left` / `1 min left` / `18 min over` — never a bare number.
 */
export function formatSlaRemaining(
  targetMin: number,
  elapsedMin: number,
): { state: 'on_track' | 'at_risk' | 'breached'; text: string } {
  const remaining = targetMin - elapsedMin;
  if (remaining < 0) {
    return { state: 'breached', text: `Target passed · ${Math.abs(remaining)} min over` };
  }
  if (remaining <= Math.max(1, Math.round(targetMin * 0.2))) {
    return { state: 'at_risk', text: `At risk · ${remaining} min left` };
  }
  return { state: 'on_track', text: `On track · ${remaining} min left` };
}

/** `0.83` → `0.83`. Never `83%` — it is a confidence, not a probability. */
export function formatConfidence(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(2);
}

/** `88.4%` — one decimal is enough and avoids false precision. */
export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

/** `1.2 MB` · `840 kB` — decimal units, matching the upload limits. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} kB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** `4` — integers, tabular, no separators below 10 000. */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(value);
}

/** `05:04` — a 120 s dispatch expiry countdown. */
export function formatCountdown(secondsRemaining: number): string {
  const s = Math.max(0, Math.ceil(secondsRemaining));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

/** `~1 min` — an age the dispatcher can scan, not the raw minute count. */
export function formatAge(ageMin: number): string {
  if (ageMin < 1) return 'just now';
  if (ageMin < 60) return `${ageMin} min`;
  const h = Math.floor(ageMin / 60);
  const m = ageMin % 60;
  if (h < 24) return m === 0 ? `${h} h` : `${h} h ${m} min`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH === 0 ? `${d} d` : `${d} d ${remH} h`;
}

/** Location accuracy as an honest phrase. FR-032 / docs/12 §7. */
export function formatAccuracy(accuracyM: number | null | undefined): string {
  if (accuracyM === null || accuracyM === undefined || !Number.isFinite(accuracyM)) {
    return 'Location unknown';
  }
  if (accuracyM <= 50) return `Accurate to about ${Math.round(accuracyM)} m`;
  if (accuracyM <= 200) return `Location is approximate to ${Math.round(accuracyM)} m`;
  return `Location is approximate ±${Math.round(accuracyM)} m`;
}
