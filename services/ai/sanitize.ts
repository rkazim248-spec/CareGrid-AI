/**
 * ============================================================================
 * CareGrid AI — the untrusted-content sanitiser
 * ============================================================================
 *
 * docs/09 §4.3. The nine steps that turn a citizen's words into something a
 * language model may be shown.
 *
 * ---------------------------------------------------------------------------
 * PURE, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 * No `process.env`, no clock, no randomness, no network. Every step is a
 * function of its input, so all nine are unit-testable and the adversarial
 * fixtures in `tests/fixtures/ai/` assert against real behaviour rather than
 * against a description of it (docs/09 §10).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS BOUNDARY IS ACTUALLY FOR
 * ---------------------------------------------------------------------------
 * Three separate problems, in descending order of severity:
 *
 *  1. **Instruction smuggling.** Text that tries to become an instruction. The
 *     structural defence is in `prompts.ts` (untrusted content never enters the
 *     system instruction); this file reduces the surface by breaking the classic
 *     override strings and scoring the attempt.
 *  2. **Invisible text.** Zero-width and bidirectional-override characters let a
 *     report carry instructions that render as nothing in a reviewer's UI and
 *     read as plain text to the model. A dispatcher reading "fire in the market"
 *     cannot see the paragraph appended after it in U+202E. Step 2 is the
 *     cheapest high-value defence in the whole AI layer.
 *  3. **Personal data leaving the system.** The report goes to a third party.
 *     Step 6 redacts emails, phone numbers, and long digit runs **in the copy
 *     sent to the model only** — the stored `originalText` keeps them, because
 *     it is evidence and a dispatcher may need to call the reporter back.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT DO, AND WHY IT CANNOT
 * ---------------------------------------------------------------------------
 * It does not make a prompt injection impossible. That is not achievable by
 * string manipulation; it is a property of the model. What it does is make the
 * cheap attacks fail, and — more importantly — make `suspicionScore` a number
 * the deterministic rules can act on, so a detected attempt degrades the result
 * whether or not the model was fooled.
 */

import { AI_INJECTION_PATTERNS } from '@/config/ai';

/* ========================================================================== */
/* The result                                                                    */
/* ========================================================================== */

/**
 * What the sanitiser produced, and what it noticed.
 *
 * Every field is carried to `aiRuns` so an operator can answer "why was this
 * report's confidence 0.4" after the fact. The counts are the evidence; without
 * them the only way to find out is to re-run the model and hope it behaves the
 * same way twice.
 */
export type SanitisedText = {
  /** The text to send. Bounded, normalised, neutralised, PII-redacted. */
  readonly text: string;
  /** ≥ 3 forces confidence ≤ 0.4 and adds `low_confidence`. docs/09 R7. */
  readonly suspicionScore: number;
  /** The patterns that matched, for the audit trail. Names only, not the text. */
  readonly suspicionHits: readonly string[];
  /** `true` when the 8-gram flood guard truncated. docs/09 §4.3 step 7. */
  readonly floodGuardApplied: boolean;
  /** `true` when anything was replaced with a `[email]`/`[phone]`/`[number]` marker. */
  readonly piiRedacted: boolean;
  /** `true` when invisible characters were removed. Worth its own audit line. */
  readonly invisibleCharactersRemoved: boolean;
};

/** docs/09 §4.3 step 1. The same bound `TRIAGE_LIMITS` enforces at the boundary. */
const MAX_TEXT_CHARS = 2000;
/** docs/09 §4.3 step 7. Where a flooded report is truncated to. */
const FLOOD_TRUNCATE_CHARS = 1000;
/** docs/09 §4.3 step 7. An 8-gram repeated more than this many times is a flood. */
const FLOOD_NGRAM = 8;
const FLOOD_MAX_REPEATS = 6;
/** docs/09 §10 — "long digit runs (>= 7 digits)". A phone number, an ID, a count. */
const LONG_DIGIT_RUN = 7;

/* ========================================================================== */
/* Step 2 + 3 — normalisation and invisible characters                          */
/* ========================================================================== */

/**
 * Zero-width, bidirectional-override, and other invisible control characters.
 *
 * The bidi range (U+202A–U+202E, U+2066–U+2069) is the dangerous one: it reverses
 * the visual order of the text that follows it, so a report can read as
 * "everything is fine" to a human reviewer while the model reads a paragraph of
 * instructions. docs/24 T-09 lists this as a named injection vector, and it is
 * the one an attacker's UI would never have to render.
 *
 * Also stripped: U+200B–U+200F (zero-width and directional marks), U+FEFF
 * (byte-order mark, which survives copy-paste from a spreadsheet), and the C1
 * control range U+0080–U+009F.
 *
 * Written as explicit escapes rather than a `\p{Cf}` property so the exact set is
 * reviewable. A broad Unicode-category strip would also remove legitimate
 * characters in Indic scripts, and this product's users write in them.
 */
const INVISIBLE_PATTERN =
  /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u00AD\u0080-\u009F]/g;

/**
 * C0 control characters, minus the whitespace that is legitimately in text.
 *
 * `\t` (U+0009), `\n` (U+000A) and `\r` (U+000D) are kept: a multi-line report is
 * normal. Everything else in U+0000–U+001F is removed, which is what stops a
 * NUL byte or a terminal escape sequence from reaching the model — and, if this
 * text were ever logged, from reaching a terminal that would act on it.
 */
const CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Steps 2 and 3. Returns the text and whether anything invisible was removed.
 *
 * NFKC first, so that full-width and compatibility forms (U+FF21, circled digits)
 * are folded to their ASCII equivalents. This matters for the *keyword* fallback
 * as much as for the model: `ＦＩＲＥ` in a full-width font would otherwise miss
 * every category rule and produce `other` with no evidence.
 */
function normalise(raw: string): { text: string; removedInvisible: boolean } {
  const normalised = raw.normalize('NFKC');
  const withoutInvisible = normalised.replace(INVISIBLE_PATTERN, '');
  const withoutControl = withoutInvisible.replace(CONTROL_PATTERN, '');
  const removedInvisible = withoutInvisible !== normalised || withoutControl !== withoutInvisible;
  return { text: withoutControl, removedInvisible };
}

/* ========================================================================== */
/* Step 5 — instruction-marker neutralisation                                   */
/* ========================================================================== */

/**
 * Strings that are the standard vocabulary of a prompt override.
 *
 * Replaced with an underscore-joined form rather than removed: the model still
 * reads the meaning ("ignore previous instructions" is still legible as
 * "ignore_previous_instructions"), so classification is unharmed, but the exact
 * token a model has been trained to treat as a control sequence is broken. Docs
 * specify a "visually similar but non-triggering form" for this reason —
 * deletion would destroy evidence a dispatcher may need to see, and the
 * sanitised copy is not the stored copy.
 *
 * Order matters: the longest patterns are listed first so `ignore previous
 * instructions` is not partially rewritten by the shorter `ignore previous` rule
 * and left with a dangling tail.
 *
 * `</citizen_report>` and `<citizen_report>` are in this list on purpose. A report
 * that closes the delimiter can put arbitrary text into system context, which
 * defeats the one structural defence in `prompts.ts`. It is the highest-value
 * entry in the table.
 */
const MARKER_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/<citizen_report>/gi, '_citizen_report_'],
  [/<\/citizen_report>/gi, '_/citizen_report_'],
  [/<untrusted_extract>/gi, '_untrusted_extract_'],
  [/<\/untrusted_extract>/gi, '_/untrusted_extract_'],
  [/ignore\s+(all\s+)?(the\s+)?(previous|prior|above|preceding)\s+(instructions?|prompts?|rules?|directions?)/gi, 'ignore_previous_instructions'],
  [/disregard\s+(all\s+)?(the\s+)?(previous|prior|above|earlier)/gi, 'disregard_previous'],
  [/(new|updated|revised)\s+instructions?\s*:/gi, 'updated_instructions:'],
  [/\bsystem\s*:/gi, 'system_:'],
  [/\bassistant\s*:/gi, 'assistant_:'],
  [/\byou\s+are\s+now\b/gi, 'you_are_now'],
  [/\bact\s+as\s+(a|an|the)\b/gi, 'act_as'],
  [/\bdeveloper\s+(mode|instructions?)/gi, 'developer_instructions'],
  [/(output|return|print|respond\s+with)\s+(only\s+)?(the\s+)?json\b/gi, 'output_json_request'],
  [/```/g, "'''"],
  [/\{\s*"/g, "{ _"],
];

/**
 * Step 5. Break the classic override tokens, case-insensitively.
 *
 * Applied AFTER PII redaction so a phone number is replaced before any pattern
 * sees it, and BEFORE the length cap so a rewritten token cannot push the text
 * over the limit and be truncated mid-replacement.
 */
function neutraliseMarkers(raw: string): string {
  let out = raw;
  for (const [pattern, replacement] of MARKER_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/* ========================================================================== */
/* Step 6 — PII redaction                                                        */
/* ========================================================================== */

/**
 * Step 6. docs/09 §4.3.
 *
 * Three patterns, in this order:
 *
 *  - **Email.** The only one that is unambiguous.
 *  - **Phone.** Deliberately loose about separators, because a reporter writes
 *    `0300-1234567`, `+92 300 1234567`, and `(0300) 123 4567` and all three are
 *    the same kind of secret. Matches an optional `+`, 7–15 digits, and
 *    separators between them.
 *  - **Long digit runs.** ≥ 7 consecutive digits. This is the catch-all: it
 *    catches a national ID, an Aadhaar-style number, a bank reference, and any
 *    phone format the previous pattern missed. It also catches a long casualty
 *    count, which is an acceptable false positive — `people_affected` comes from
 *    a *stated* number, and losing an 8-digit figure from the model's copy costs
 *    one `unknown_fields` entry while a national ID in a third party's logs costs
 *    something that cannot be taken back.
 *
 * Replaced with `[email]`, `[phone]`, `[number]` so the model can still see that
 * *something* identifying was there, which matters for a report whose only
 * distinguishing detail is "I left my number on the gate".
 */
function redactPii(raw: string): { text: string; redacted: boolean } {
  const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const phone = /\+?\d[\d\s().-]{5,}\d/g;
  const longDigits = new RegExp(`\\d{${LONG_DIGIT_RUN},}`, 'g');

  let out = raw;
  let redacted = false;

  // Order is load-bearing: email first, then phone, then the digit catch-all.
  // Running the digit rule first would break a phone number into `[number]` and
  // leave the country code behind as text the model reads as a location.
  for (const [pattern, marker] of [
    [email, '[email]'],
    [phone, '[phone]'],
    [longDigits, '[number]'],
  ] as const) {
    out = out.replace(pattern, () => {
      redacted = true;
      return marker;
    });
  }

  return { text: out, redacted };
}

/* ========================================================================== */
/* Step 8 — injection heuristics                                                */
/* ========================================================================== */

/**
 * Step 8. docs/09 §4.3.
 *
 * Returns a SCORE, not a boolean. A single "ignore previous instructions" in an
 * otherwise ordinary report is not the same as three: the first may be a
 * copy-pasted chain message, and the third means the text is aimed at the model.
 * A boolean would have to pick a threshold, and any threshold is either too
 * strict (flagging a forwarded message and capping a legitimate report's
 * confidence) or too lax (missing a two-phrase attack).
 *
 * The patterns live in `config/ai.ts` beside the copy, so adding one is a config
 * change and the score semantics stay in one place.
 */
function scoreSuspicion(text: string): { score: number; hits: readonly string[] } {
  const hits: string[] = [];
  for (const pattern of AI_INJECTION_PATTERNS) {
    if (pattern.test.test(text)) hits.push(pattern.name);
  }
  // Capped at the number of patterns: a text containing every phrase gains
  // nothing over one containing most of them, and an uncapped score would let a
  // flood of repeats push every downstream threshold to its limit.
  return { score: Math.min(hits.length, AI_INJECTION_PATTERNS.length), hits };
}

/* ========================================================================== */
/* Step 7 — the flood guard                                                      */
/* ========================================================================== */

/**
 * Step 7. docs/09 §4.3: an 8-gram repeated more than 6 times is a flood.
 *
 * The purpose is cost and context, not safety. A repeated token run is either an
 * attempt to push a value out of the model's effective context or a stuck
 * client, and both waste the whole request budget for no triage value.
 *
 * Truncating to 1000 chars rather than rejecting is deliberate: a real emergency
 * can be buried after 2,000 characters of repeated text, and a truncated triage
 * of a partly-legible report is worth more than no triage (FR-029).
 */
function applyFloodGuard(raw: string): { text: string; applied: boolean } {
  const words = raw.split(/\s+/).filter((w) => w.length > 0);
  if (words.length < FLOOD_NGRAM * 2) return { text: raw, applied: false };

  const seen = new Map<string, number>();
  let worst = 0;

  for (let i = 0; i + FLOOD_NGRAM <= words.length; i += 1) {
    // Lower-cased: a flood that varies case (`FIRE fire FIRE`) is the same flood,
    // and case-folding it here is what makes the guard robust to the trivial
    // evasion of alternating case.
    const gram = words.slice(i, i + FLOOD_NGRAM).join(' ').toLowerCase();
    const count = (seen.get(gram) ?? 0) + 1;
    seen.set(gram, count);
    if (count > worst) worst = count;
  }

  if (worst <= FLOOD_MAX_REPEATS) return { text: raw, applied: false };
  return { text: raw.slice(0, FLOOD_TRUNCATE_CHARS), applied: true };
}

/* ========================================================================== */
/* The entry point                                                               */
/* ========================================================================== */

/**
 * Sanitise one citizen report for the model.
 *
 * The step ORDER is not arbitrary, and TWO of the orderings are load-bearing:
 *
 *  1. **Normalise → redact → neutralise.** Full-width text is folded first so
 *     the marker patterns see ASCII. Redaction runs before neutralisation so a
 *     neutralised token cannot accidentally satisfy a digit-run pattern.
 *  2. **SCORE ON THE NORMALISED TEXT, BEFORE NEUTRALISATION.**
 *
 *     This is the ordering that a test caught, and getting it wrong is a safety
 *     bug rather than a cosmetic one. The neutraliser *catches* the canonical
 *     override strings — that is what it is for — so scoring afterwards means the
 *     most standard attack in existence ("ignore previous instructions") is
 *     rewritten to `ignore_previous_instructions` and then scores **zero**. Only
 *     phrasings the rewriter misses would score. R7 caps confidence at 0.4 above
 *     a score of 3, so the effect is precisely inverted: the easiest attack gets
 *     the highest confidence and an obscure one gets flagged.
 *
 *     Scoring the normalised text decouples DETECTION from MITIGATION. They are
 *     independent properties: the rewrite reduces what the model can be told to
 *     do, and the score reduces how much the answer is trusted. Neither should
 *     depend on whether the other happened to fire.
 *  3. **Flood guard → length cap.** The flood guard truncates to 1,000; the
 *     length cap then enforces the hard 2,000 ceiling. Running the cap first
 *     would mean the flood guard never sees the part it was meant to shorten.
 */
export function sanitiseForModel(raw: string): SanitisedText {
  const { text: normalised, removedInvisible } = normalise(raw);
  // `redaction` is the result object and `piiRedacted` the boolean. They were
  // briefly one identifier, which TypeScript caught as a redeclaration — the
  // narrowest possible warning for a bug that would otherwise have shipped a
  // string where a boolean belonged.
  const redaction = redactPii(normalised);
  const { score, hits } = scoreSuspicion(redaction.text);

  const neutralised = neutraliseMarkers(redaction.text);
  const { text: unflooded, applied: floodGuardApplied } = applyFloodGuard(neutralised);
  // Trimmed: leading and trailing whitespace in a report is noise, and a
  // whitespace-only report should be the empty string rather than a run of
  // spaces sent to a model as if it were content.
  const text = unflooded.trim().slice(0, MAX_TEXT_CHARS);

  return {
    text,
    suspicionScore: score,
    suspicionHits: hits,
    floodGuardApplied,
    piiRedacted: redaction.redacted,
    invisibleCharactersRemoved: removedInvisible,
  };
}

/**
 * Sanitise a short label — a `coarseArea`, a landmark — with the same rules and
 * a tighter cap.
 *
 * These reach the prompt as SYSTEM CONTEXT rather than as report content, so they
 * get the marker neutralisation too: a district name is user-controlled through
 * a maps response, and a place called "Ignore Previous Instructions Market" is a
 * place name that would otherwise sit in the trusted part of the turn.
 */
export function sanitiseLabel(raw: string, maxChars: number): string {
  const { text } = normalise(raw);
  return neutraliseMarkers(text).slice(0, maxChars);
}

/** The caps, exported so `validators/ai.ts` and the tests can assert them. */
export const SANITISER_LIMITS = {
  maxTextChars: MAX_TEXT_CHARS,
  floodTruncateChars: FLOOD_TRUNCATE_CHARS,
  floodNgram: FLOOD_NGRAM,
  floodMaxRepeats: FLOOD_MAX_REPEATS,
  longDigitRun: LONG_DIGIT_RUN,
  /** docs/09 §4.3 step 8. R7 acts at or above this. */
  suspicionThreshold: 3,
} as const;
