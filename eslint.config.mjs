import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

/**
 * ESLint 9 flat config.
 *
 * Beyond the standard Next + TypeScript rules, this file enforces FOUR
 * project-specific design-system rules from docs/30_DEVELOPMENT_PHASE_PLAN.md
 * §4.5. They are lint rules rather than review conventions because a convention
 * that is not mechanical does not survive contact with a deadline.
 *
 *   1. no `gradient-to-*`        — this is an operations console, not a
 *                                  marketing template (docs/04 A1)
 *   2. no hex literal in a class — colour lives in app/styles/globals.css only
 *   3. no inline colour style    — same reason; also blocks a per-component
 *                                  palette that design review would miss
 *   4. no literal `aria-label`   — the accessible name must come from a prop or
 *                                  a config table, so a screen-reader string
 *                                  cannot drift from the visible label
 */
const designSystemRules = [
  // 1. No gradients.
  {
    selector:
      'JSXAttribute[name.name="className"] Literal[value=/\\b(gradient-to-|bg-linear-|bg-radial-)/]',
    message:
      'No gradients in this project. CareGrid AI is an operations console; elevation is border first, shadow second (docs/04 §1.3 A1, §4.3).',
  },
  // 2. No hex literal in a className or style value.
  {
    selector: 'JSXAttribute > Literal[value=/#[0-9a-fA-F]{3,8}\\b/]',
    message:
      'No hex literal here. Colour is declared once in app/styles/globals.css and consumed as a Tailwind token (docs/04 §2.1 rule 1).',
  },
  {
    selector: 'Literal[value=/#[0-9a-fA-F]{6}\\b/]',
    message:
      'No hex literal here. Use a token such as `text-urgency-critical` or a class from config/.',
  },
  // 3. No inline colour styles.
  {
    selector:
      'JSXAttribute[name.name="style"] > JSXExpressionContainer > ObjectExpression > Property[key.name="color"]',
    message:
      'No inline colour. Use a token class. A per-component colour is a palette the design system does not know about (docs/04 §2.1).',
  },
  // 4. No literal aria-label on a CONTROL.
  //
  // Scoped to interactive elements on purpose. A literal on a LANDMARK
  // (`<nav aria-label="Primary">`, `<ul aria-label="Incident queue">`) is a
  // fixed structural name with no prop to take it from, and banning it would
  // only push developers toward worse workarounds. A literal on a CONTROL is
  // the real hazard: it drifts from the visible label the moment someone edits
  // the text, and a screen-reader user then hears something the screen does not
  // show. Those must come from a required prop (`IconButton.label`) or a config
  // table (docs/04 §5.2).
  {
    selector:
      'JSXOpeningElement[name.name=/^(button|a|input|select|textarea|summary|details|option)$/] > JSXAttribute[name.name="aria-label"] > Literal',
    message:
      'No literal aria-label on a control. Take the name from a required prop (IconButton.label) or a config table, so the accessible name cannot drift from the visible label (docs/04 §5.2). Landmark and list labels may be literals.',
  },
];

const eslintConfig = [
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'out/**',
      'coverage/**',
      'next-env.d.ts',
      'npm-install.log',
    ],
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // NFR-022: zero `any` in app/, features/, services/, lib/.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'warn',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // A hard `console.*` in app code hides the fact that a real logger exists
      // (lib/server/logging.ts in Phase 6).
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
    },
  },
  {
    // The four design-system rules. Deliberately scoped to components/ and
    // features/ — config/ and lib/ legitimately hold hex-free data tables and
    // the one file that owns colour.
    files: ['components/**/*.{ts,tsx}', 'features/**/*.{ts,tsx}', 'app/**/*.{ts,tsx}'],
    rules: { 'no-restricted-syntax': ['error', ...designSystemRules] },
  },
  {
    // Import boundaries (docs/05 §4). A cycle between components/ and features/
    // is invisible until a bundle size doubles for no reason.
    //
    // SCOPED TO components/** ONLY. `components/**` must not import from
    // `features/**` because components are the lower layer. `app/**` and
    // `features/**` MUST import from features — that is the one legal direction
    // the spec describes, and applying the ban repo-wide would make the
    // documented architecture unimplementable.
    files: ['components/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/features/**'],
              message:
                'components/** must not import from features/** — components are lower-level. Move the shared piece into components/domain. (docs/05 §4)',
            },
            {
              group: ['@/services/**'],
              message:
                'components/** must not import from services/** — services are server-only and would pull the Admin SDK into the browser bundle. (docs/05 §4, NFR-013)',
            },
            {
              group: ['@/lib/server/**', '@/lib/firebase/**'],
              message:
                'Server-only module. Never import from a client component. (docs/05 §4)',
            },
            {
              group: ['@/app/api/**'],
              message: 'Route handlers are not importable from the app tree. (docs/05 §4)',
            },
          ],
        },
      ],
    },
  },
  {
    // Server-only module boundaries.
    //
    // SCOPED TO components/ AND features/, and that scoping is load-bearing in
    // both directions:
    //
    //   - `app/api/**` route handlers are SERVER files. They must be able to
    //     import `lib/server/**`; that is their entire job. Banning it there
    //     would make the API unimplementable.
    //   - `lib/firebase/client.ts` and `lib/firebase/auth.ts` ARE the BROWSER
    //     modules. Phase 1 banned `@/lib/firebase/**` everywhere because nothing
    //     used it; Phase 2 made it the client SDK, so the ban is now wrong and
    //     has been narrowed to what is genuinely server-only: `lib/server/**`
    //     and `lib/env.server.ts`, both of which carry `import 'server-only'`
    //     as a build-time guarantee.
    //
    // The `server-only` package is the primary mechanism — it throws at build
    // time if a client bundle reaches these files. This rule is the second,
    // independent check, and it produces a message that says WHY.
    files: ['components/**/*.{ts,tsx}', 'features/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/lib/server/**', '@/lib/env.server', '@/lib/env.maintenance'],
              message:
                'Server-only module — it carries `import \'server-only\'`. A client bundle that ' +
                'reaches it will not build. If you need this in a component, the logic belongs ' +
                'behind a Route Handler. (docs/05 §4, NFR-013)',
            },
          ],
        },
      ],
    },
  },
  {
    // `app/global-error.tsx` supplies its own <html> because it REPLACES the
    // document when a provider fails. There is no stylesheet and no Tailwind at
    // that point, so its colours must be literals. Same for the `themeColor`
    // viewport meta, which is parsed by the browser before any CSS loads.
    files: ['app/global-error.tsx', 'app/layout.tsx'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['tests/**/*.{ts,tsx}', '**/*.test.{ts,tsx}', 'scripts/**/*.{ts,tsx}', 'scripts/**/*.cjs'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      // A .cjs maintenance script runs under plain node, before any build.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
];

export default eslintConfig;
