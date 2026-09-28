/**
 * AI configuration — the injection patterns and the tuning constants.
 *
 * docs/09 §4.3 step 8 and §5.4. This file exists so the *vocabulary* of an attack
 * and the *thresholds* that act on it are both in one place, away from the code
 * that uses them, and reviewable without reading the pipeline.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PATTERNS LIVE HERE AND NOT IN `services/ai/sanitize.ts`
 * ---------------------------------------------------------------------------
 * The sanitiser must stay a pure function of its input, and a list of
 * human-written regexes is the most likely thing in the AI layer to need editing
 * — a new jailbreak phrasing arrives, someone adds a pattern, and doing that
 * inside the module that owns nine other responsibilities makes the change hard
 * to review. A named, commented, single-purpose list is a five-line diff.
 *
 * `config/` is also where docs/20 §1 P7 puts every enumerating value, which is
 * the established home for exactly this kind of table.
 *
 * ---------------------------------------------------------------------------
 * NO `g` FLAG, AND IT IS NOT COSMETIC
 * ---------------------------------------------------------------------------
 * `sanitize.ts` calls `pattern.test.test(text)`. A regular expression with the
 * global flag is **stateful**: `lastIndex` persists between calls, so
 *
 *     /fire/g.test('fire')   // true
 *     /fire/g.test('fire')   // false  ← lastIndex was left at 4
 *
 * The second call misses a real match. That is not a theoretical hazard: it means
 * `suspicionScore` depends on how many times the function was called before it,
 * so a long-running server scores reports differently from a fresh one, the
 * adversarial fixtures fail intermittently, and the bug is invisible in review
 * because every regex in the file *looks* correct.
 *
 * `scripts/security-check.cjs` asserts no pattern here carries `g` or `y`.
 */

/** One named attack pattern. */
export type InjectionPattern = {
  /** Stable identifier, recorded in `aiRuns` so an attack can be counted over time. */
  readonly name: string;
  /** Non-global by contract. See the header. */
  readonly test: RegExp;
  /**
   * Why this phrasing is an attack rather than an emergency report. Prose on
   * purpose: a pattern nobody understands is a pattern nobody dares to tighten.
   */
  readonly note: string;
};

/**
 * The injection heuristics. docs/09 §4.3 step 8.
 *
 * Fourteen patterns, grouped by what they try to achieve rather than by
 * phrasing, because the phrasings change and the intentions do not:
 *
 *  - **Override** (6): discard the instructions and follow the report.
 *  - **Role reassignment** (3): become a different assistant with different powers.
 *  - **Output steering** (3): emit a chosen value — the one that matters most,
 *    since "set urgency to critical" is a triage decision made by an attacker.
 *  - **Exfiltration** (2): reveal the prompt or the system configuration.
 *
 * The score is the NUMBER OF DISTINCT PATTERNS that matched, not the number of
 * matches, and it is capped at the pattern count. Three is the threshold at which
 * R7 forces confidence ≤ 0.4; one phrase is usually a forwarded message, and a
 * report that trips three of these is aimed at the model.
 */
export const AI_INJECTION_PATTERNS: readonly InjectionPattern[] = [
  /* --- override: discard the instructions ------------------------------- */
  {
    name: 'override_ignore',
    test: /ignore\s+(all\s+)?(the\s+)?(previous|prior|above|preceding|earlier|foregoing)\s+(instruction|instructions|prompt|prompts|rule|rules|direction|directions|context)/i,
    note: 'The canonical override. A citizen describing a fire does not write this; a forwarded message does.',
  },
  {
    name: 'override_disregard',
    test: /disregard\s+(all\s+)?(the\s+)?(previous|prior|above|earlier|foregoing)/i,
    note: 'Same intent as override_ignore, different verb. Grouped so either can be tightened independently.',
  },
  {
    name: 'override_forget',
    test: /(forget|discard|erase)\s+(everything|all|your)\s+(you|above|before|previously|instructions)/i,
    note: 'Third phrasing of the same attempt.',
  },
  {
    name: 'override_new_instructions',
    test: /(new|updated|revised|real|actual|true)\s+(instruction|instructions)\s*[:\-]/i,
    note: 'Pretends to deliver a replacement instruction set, usually immediately after an override.',
  },
  {
    name: 'override_from_now_on',
    test: /from\s+now\s+on\s+(you|your)\s+(will|must|should|are|is)\b/i,
    note: 'Attempts a durable change of behaviour rather than a one-shot override.',
  },
  {
    name: 'override_end_of_prompt',
    test: /(end\s+of\s+(prompt|instructions)|\[?\/?\s*(system|instructions?)\s*\]?\s*:?\s*(end|stop))/i,
    note: 'A fake terminator. Targets parsers and templates that delimit the instruction block.',
  },

  /* --- role reassignment ---------------------------------------------- */
  {
    name: 'role_you_are_now',
    test: /you\s+are\s+(now|no\s+longer|actually)\b/i,
    note: 'Attempts to change what the model is. The prompt forbids the model from claiming dispatch powers; this tries to hand it some.',
  },
  {
    name: 'role_act_as',
    test: /(act|behave|respond|operate|function)\s+(as|like)\s+(a|an|the)?\s*(unrestricted|unfiltered|uncensored|developer|admin|administrator|doctor|dispatcher|police|root)/i,
    note: 'Named-role escalation. `dispatcher` and `doctor` are here because those are the two roles whose powers would be dangerous to borrow.',
  },
  {
    name: 'role_developer_mode',
    test: /(developer|debug|god|admin|jailbreak|dan)\s*mode\b/i,
    note: 'The folklore jailbreak openers.',
  },

  /* --- output steering -------------------------------------------------- */
  {
    name: 'steer_output_json',
    test: /(output|return|print|respond\s+with|write|emit)\s+(only\s+)?(the\s+)?(json|following\s+json|this\s+json)/i,
    note: 'Attempts to replace the response schema. Harmless alone because `.strict()` still applies — which is the point of testing it here.',
  },
  {
    name: 'steer_set_urgency',
    test: /(set|change|make|mark|force)\s+(the\s+)?(urgency|priority|severity|category|status)\s+(to|as)\b/i,
    note: 'A triage decision dictated by the submitter. The highest-value target in this whole table, which is why it is a separate rule.',
  },
  {
    name: 'steer_false_alarm',
    test: /(mark|classify|set|flag|label)\s+(this|it|that|them)?\s*(as\s+)?(a\s+)?(false\s+alarm|not\s+(an\s+)?emergency|no\s+emergency|resolved|cancelled|canceled|test(ing)?\s+only)/i,
    note: 'The mirror of steer_set_urgency: suppressing a real emergency rather than escalating a fake one.',
  },

  /* --- exfiltration ----------------------------------------------------- */
  {
    name: 'exfil_system_prompt',
    test: /(reveal|show|print|repeat|output|display|tell\s+me)\s+(me\s+)?(your|the)\s+(system\s+)?(prompt|instructions|configuration|rules|directive)/i,
    note: 'Prompt extraction. Breaches the brief\'s "never expose the system prompt to the client" requirement, and leaks the resource catalogue and SLA table with it.',
  },
  {
    name: 'exfil_api_key',
    test: /(api[_\s-]?key|access[_\s-]?token|secret|credential|bearer\s+token|env(ironment)?\s+var)/i,
    note: 'Aiming at a server secret. The key is never in the prompt, so this is scored but has nothing to steal — and the attempt is itself worth logging.',
  },
];

/**
 * Confidence bands. docs/09 §5.4.
 *
 * The thresholds are the specification and `AI_CONFIDENCE_REVIEW_THRESHOLD`
 * overrides the low band at runtime for FR-024. Both are exported so a component
 * and `rules.ts` band identically — a UI that says "high" at 0.72 while the rules
 * engine treats it as "needs review" is two sources of truth for one judgement.
 */
export const AI_CONFIDENCE_BANDS = {
  high: 0.8,
  medium: 0.6,
} as const;

/** The ceiling R7 applies when `suspicionScore` reaches the threshold. */
export const AI_SUSPICION_CONFIDENCE_CEILING = 0.4;

/**
 * The ceiling on an AI-inferred resource's confidence. docs/09 §1.2 rule 5 and
 * §6.
 *
 * 0.5 exactly: the resource is a suggestion for a human, and anything above half
 * confidence on an inference is the model asserting a need nobody stated. A
 * reporter who explicitly asked for something is the exception, and that
 * resource is marked `source: 'reporter'` at confidence 1.0 in `rules.ts`.
 */
export const AI_INFERRED_RESOURCE_CONFIDENCE_CAP = 0.5;

/** What a model-inferred resource's own `confidence` is capped at. docs/09 §6. */
export const AI_MODEL_RESOURCE_CONFIDENCE_CAP = 0.4;

/**
 * The inline base64 budget for one request. docs/09 §4.2.
 *
 * Base64 inflates by ~1.37×, so this is ~11 MB of real bytes. Under Google's 20 MB
 * request ceiling with room for the prompt and the JSON response. Images are
 * dropped **in reverse order** past this, and the drop is recorded — a model that
 * saw two of three photos must not appear to have seen three.
 */
export const AI_MAX_INLINE_BYTES = 15 * 1024 * 1024;

/** FR-005. The most images one triage call may carry. */
export const AI_MAX_IMAGES = 3;

/** FR-006. The most audio clips, and the longest. */
export const AI_MAX_AUDIO = 1;
export const AI_MAX_AUDIO_SECONDS = 120;
