'use client';

/**
 * The Google "G" mark.
 *
 * ---------------------------------------------------------------------------
 * WHY AN INLINE SVG AND NOT AN IMAGE FILE OR AN ICON PACKAGE
 * ---------------------------------------------------------------------------
 * It is one specific brand mark, so `lucide-react` does not have it. An external
 * file would be one more network request for one 16px glyph that appears on two
 * screens, and an icon package installed for a single glyph is a dependency
 * someone has to audit. Inline SVG it is.
 *
 * The four paths are Google's official single-colour mark, filled with
 * `currentColor` so it inherits the button's text colour in both themes. It is
 * `aria-hidden` because the button that contains it already reads "Continue with
 * Google" — announcing the logo as well would make the control's name "Google,
 * Continue with Google".
 */
export function GoogleMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      focusable="false"
      fill="currentColor"
    >
      <path d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47a5.54 5.54 0 0 1-2.4 3.63v3.02h3.86c2.26-2.09 3.56-5.17 3.56-8.89z" />
      <path d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3.02c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.28v3.13A12 12 0 0 0 12 24z" />
      <path d="M5.27 14.28a7.2 7.2 0 0 1 0-4.56V6.59H1.28a12 12 0 0 0 0 10.82l3.99-3.13z" />
      <path d="M12 4.77c1.76 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.28 6.59l3.99 3.13C6.22 6.87 8.87 4.77 12 4.77z" />
    </svg>
  );
}
