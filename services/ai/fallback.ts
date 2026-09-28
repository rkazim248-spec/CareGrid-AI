/**
 * ============================================================================
 * CareGrid AI — the keyword fallback triage engine
 * ============================================================================
 *
 * docs/09 §7.2. PURE, OFFLINE, and the reason FR-029 is true rather than
 * aspirational.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 * A citizen pressing "send" during a medical emergency must not lose their
 * report because a quota was exhausted 3,000 km away, a key was rotated
 * mid-incident, or Google had an outage. This engine produces a plausible,
 * honest triage with **no network at all**, so the incident is still created, the
 * dispatcher still sees it, and it is visibly flagged as needing human review.
 *
 * The AI is on the critical path of *speeding up* a response. It is never on the
 * critical path of *recording* one.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CONFIDENCE IS CAPPED AT 0.55 AND NOT HIGHER
 * ---------------------------------------------------------------------------
 * Because keyword matching genuinely is less informative than a model reading
 * the whole report, and the cap makes the system say so. `AI_CONFIDENCE_BANDS`
 * puts 0.6 at the bottom of the "medium" band and `AI_CONFIDENCE_REVIEW_THRESHOLD`
 * defaults to 0.6 — so a capped 0.55 always renders "Needs review" (FR-024) and
 * always sorts up the dispatcher's queue (docs/09 §5.4).
 *
 * A fallback that reported 0.9 would defeat the entire flag. A citizen in an
 * emergency deserves to know that what they are reading came from string
 * matching, because they are being asked to confirm it.
 *
 * ---------------------------------------------------------------------------
 * THE TWO HARD RULES, STATED WHERE THEY CANNOT BE MISSED
 * ---------------------------------------------------------------------------
 *  1. `peopleAffected` is **always** `null`. A keyword engine cannot count
 *     people. It can see the word "two", and "two" appears in "two streets
 *     away" as often as in "two people injured". docs/09 §1.2 rule 4 and R4.
 *  2. `locationHint` is **always** `null`. docs/09 §1.2 rule 3: the AI has no
 *     location output field except an approximation, and a keyword engine has
 *     even less claim to one than a model does.
 *
 * Both are asserted directly in `tests/unit/ai/fallback.test.ts` over every input
 * in the fixture set, not just the example.
 */

import { SAFETY_FLAGS, URGENCIES } from '@/types/enums';
import type { IncidentCategory, SafetyFlag, Urgency } from '@/types/enums';
import { categoryLabel } from '@/config/categories';
import { AI_HAZARDS, type AiHazard, type AiUnknownField } from '@/services/ai/schema';
import type { NormalizedTriage } from '@/services/ai/rules';

/* ========================================================================== */
/* The keyword tables                                                           */
/* ========================================================================== */

/**
 * Category rules, docs/09 §7.2.
 *
 * Each entry is `[category, keywords, highSignal]`. The third element is what
 * earns the +0.1 confidence step: matching "fire" is suggestive, matching
 * "not breathing" is specific. Without the split, a report containing both "car"
 * and "chest pain" would score identically to one containing only "car", which is
 * the same confidence for two very different amounts of evidence.
 *
 * A category can be reached by summing several weak signals or by one strong
 * signal. That is deliberate and it is why this file has a `highSignal` list per
 * category rather than a weight per keyword.
 */
const CATEGORY_RULES: readonly (readonly [IncidentCategory, readonly string[], readonly string[]])[] = [
  [
    'medical',
    ['injur', 'hurt', 'pain', 'sick', 'ill', 'unwell', 'bleeding', 'blood', 'wound', 'ambulance', 'hospital', 'clinic', 'doctor', 'faint', 'collapsed', 'seizure', 'convulsion', 'burn', 'fracture', 'broken arm', 'chest pain', 'overdose', 'childbirth', 'labour', 'labor', 'high temperature', 'fever', 'not breathing', 'unconscious', 'trapped', 'injured'],
    ['not breathing', 'unconscious', 'chest pain', 'seizure', 'convulsion', 'overdose', 'childbirth', 'fracture', 'no pulse', 'unresponsive'],
  ],
  [
    'fire',
    ['fire', 'smoke', 'smoking', 'flame', 'flames', 'burning', 'blaze', 'inferno', 'arson'],
    ['fire', 'blaze', 'flames', 'inferno'],
  ],
  [
    'traffic_accident',
    ['accident', 'crash', 'collision', 'collided', 'hit', 'rammed', 'overturned', 'skid', 'rolled over', 'road', 'traffic', 'bike', 'motorcycle', 'scooter', 'car', 'truck', 'bus', 'van', 'vehicle', 'two-wheeler', 'rider', 'driver'],
    ['accident', 'crash', 'collision', 'overturned', 'ran over', 'hit by'],
  ],
  [
    'flood',
    [
      'flood',
      'flooding',
      'flooded',
      'waterlogged',
      'waterlogging',
      'waterlog',
      'drain',
      'drains',
      'drainage',
      'submerged',
      'storm water',
      'inundated',
      'overflowing',
      'ponded',
      // "Water is entering houses after heavy rain" is THE canonical flood
      // report, and none of the words in it matched: "water" is a `community_aid`
      // term and "rain" was absent, so the engine classified it as a request for
      // drinking water. The phrases below are how the report is actually written.
      'water entering',
      'water coming in',
      'water coming into',
      'water inside',
      'water in the house',
      'entering house',
      'entering houses',
      'heavy rain',
      'rainwater',
      'sewage overflow',
    ],
    ['flooding', 'flooded', 'waterlogged', 'submerged', 'inundated', 'water entering', 'entering houses'],
  ],
  [
    'heatwave',
    [
      'heat',
      'heatwave',
      'heat wave',
      // Multi-word phrases FIRST-class alongside single words, because a specific
      // phrase must outweigh a generic one. "Several elderly people are feeling
      // unwell due to extreme heat" scored 1 for `medical` (via "unwell") and 1 for
      // `heatwave` (via "heat"), and the tie went to `medical` because it is
      // earlier in the table — which classified a heat emergency as a medical one.
      // "extreme heat" tips it correctly, and is the phrase people actually use.
      'extreme heat',
      'severe heat',
      'sunstroke',
      'sun stroke',
      'dehydration',
      'dehydrated',
      'sunburn',
      'hot',
      'scorching',
      'oppressive heat',
    ],
    ['heatstroke', 'sunstroke', 'heat wave', 'heatwave', 'extreme heat'],
  ],
  [
    'severe_storm',
    ['storm', 'cyclone', 'hurricane', 'typhoon', 'lightning', 'thunder', 'wind', 'windy', 'gale', 'tree', 'trees', 'tornado', 'hail'],
    ['cyclone', 'hurricane', 'typhoon', 'tornado', 'lightning'],
  ],
  [
    'missing_person',
    ['missing', 'disappeared', 'not found', 'unaccounted', 'vanished', 'lost child', 'child missing', 'wandered off'],
    ['missing person', 'missing child', 'disappeared', 'unaccounted for', 'not found'],
  ],
  [
    'violence_crime',
    ['attack', 'attacked', 'assault', 'assaulted', 'stabbed', 'stab', 'shot', 'gunshot', 'robbed', 'robbery', 'theft', 'riot', 'riots', 'violence', 'armed', 'weapon', 'knife', 'fighting', 'beaten'],
    ['stabbed', 'gunshot', 'armed', 'assaulted', 'riots'],
  ],
  [
    'infrastructure',
    ['power', 'outage', 'electricity', 'transformer', 'gas leak', 'gas smell', 'smell of gas', 'pipe', 'burst pipe', 'water supply', 'no water', 'collapsed', 'collapse', 'ceiling fell', 'power cut', 'short circuit', 'wire down', 'broken pipe', 'sewage'],
    ['collapsed', 'gas leak', 'burst pipe', 'transformer', 'power outage'],
  ],
  [
    'community_aid',
    ['food', 'water', 'medicine', 'medication', 'shelter', 'help needed', 'need help', 'welfare', 'elderly alone', 'disabled', 'supplies', 'rations', 'blanket', 'meds'],
    ['need help', 'help needed', 'no food', 'no medicine', 'elderly alone'],
  ],
];

/**
 * Urgency terms. docs/09 §7.2.
 *
 * Ordered by severity and **scanned in order, first match wins** — rather than
 * counted. A report saying "gas smell and my leg hurts" must be `critical`
 * because of the gas, and a counting scheme that adds a point for "leg" and a
 * point for "smell" can reach `high` and stop. First-match-wins cannot
 * under-escalate, which is the only direction that matters for a triage floor.
 */
const URGENCY_TERMS: readonly (readonly [Urgency, readonly string[]])[] = [
  [
    'critical',
    [
      'trapped',
      'not breathing',
      // The two phrases a bystander actually types. `unresponsive` and
      // `unconscious` are the clinical words; "not responding" and "not waking"
      // are what a frightened member of the public writes, and a report using
      // them is the most common medical emergency in the product. Found by the
      // Phase 4 test that asserted the fallback's urgency for
      // "collapsed ... and is not responding" — it came back `low`.
      'not responding',
      'not waking',
      'cannot wake',
      'unconscious',
      'bleeding heavily',
      'pinned',
      'unresponsive',
      'gas smell',
      'smell of gas',
      'gas leak',
      'shot',
      'stabbed',
      'child missing near water',
      'pregnant',
      'under the car',
      'fire spreading',
      'flames',
      'blaze',
      'crowd panic',
      'collapsed on',
      'chest pain',
      'overdose',
      'self harm',
      'self-harm',
    ],
  ],
  ['high', ['accident', 'crash', 'injured', 'broken arm', 'road blocked', 'rising water', 'water rising', 'water is rising', 'water level rising', 'flooding', 'crowd', 'collapse', 'collapsed', 'smoke', 'fire', 'unconscious person', 'bleeding', 'trapped in', 'missing child']],
  // "Power is out", "no electricity" and "blackout" are the phrases people
  // actually type; "power cut" and "outage" are the phrases a utility company
  // uses. Matching only the latter scored the most common form of this report as
  // `low`.
  ['medium', ['leak', 'power cut', 'power is out', 'power outage', 'no electricity', 'no power', 'blackout', 'smell', 'no water', 'outage', 'blocked', 'damaged', 'down', 'flooded']],
];

/**
 * Hazard keywords, mapped to the hazard enum. docs/09 §7.2.
 *
 * The flood row carries the same multi-word phrases as the category table, and for
 * the same reason: `flood_water` is what raises the `flood_rising` flag, and a test
 * asserting it on the canonical flood report ("water is entering houses after
 * heavy rain") failed because the hazard table only knew the words the
 * *terminology* uses rather than the words the *reporter* uses.
 *
 * A hazard that is not detected produces a report with no `flood_rising` flag,
 * which is the difference between a dispatcher seeing a rising-water warning and
 * seeing a plain flood report.
 */
const HAZARD_TERMS: readonly (readonly [AiHazard, readonly string[]])[] = [
  ['fire', ['fire', 'flames', 'blaze', 'burning']],
  ['smoke', ['smoke', 'smoking']],
  ['gas_leak', ['gas leak', 'smell of gas', 'gas smell']],
  ['live_wire', ['live wire', 'wire down', 'exposed cable', 'short circuit']],
  [
    'flood_water',
    [
      'flood water',
      'rising water',
      'water is rising',
      'water rising',
      'water level rising',
      'waterlogged',
      'submerged',
      'flooded',
      'water entering',
      'water coming in',
      'water inside',
      'entering houses',
      'rainwater',
    ],
  ],
  ['structural_risk', ['collapsed', 'collapse', 'cracked wall', 'damaged building', 'rubble']],
  ['weapon', ['weapon', 'gun', 'knife', 'armed', 'shot', 'stabbed']],
  ['crowd', ['crowd', 'stampede', 'people gathered']],
  ['child_present', ['child', 'children', 'baby', 'toddler', 'kid']],
  ['elderly_present', ['elderly', 'old man', 'old woman', 'senior', 'grandmother', 'grandfather']],
  ['pregnant_person', ['pregnant', 'expecting a baby', 'in labour', 'in labor']],
];

/* ========================================================================== */
/* The engine                                                                    */
/* ========================================================================== */

/** What the caller supplies. Nothing here is derived from a clock or a network. */
export type FallbackInput = {
  readonly text: string;
  readonly language: string;
  /** A district label at most. `null` when the device supplied no location. */
  readonly coarseArea: string | null;
  readonly hasCoordinates: boolean;
  readonly reviewThreshold: number;
};

export type FallbackResult = {
  readonly normalized: NormalizedTriage;
  /** Which category keywords matched, for the dispatcher panel. Never shown raw. */
  readonly matchedCategoryTerms: readonly string[];
  readonly matchedUrgencyTerm: string | null;
};

/** The confidence arithmetic. docs/09 §7.2. Named so the test can assert it. */
const BASE_CONFIDENCE = 0.25;
const HIGH_SIGNAL_STEP = 0.1;
export const FALLBACK_MAX_CONFIDENCE = 0.55;

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Triage with no model. Never throws, never returns a null category or urgency.
 *
 * Always returns a complete `NormalizedTriage`, so the caller has one code path
 * for storing the result whether the model answered or not — which is the point.
 * A fallback that returned nulls would be the same as no triage, and the whole
 * value of this engine is that it produces something honest instead.
 */
export function fallbackTriage(input: FallbackInput): FallbackResult {
  const text = input.text.toLowerCase();

  /* --- category: highest score wins, `other` when nothing scores -------- */
  let category: IncidentCategory = 'other';
  let bestScore = 0;
  let matchedCategoryTerms: string[] = [];
  let highSignalHits = 0;

  for (const [candidate, terms, strong] of CATEGORY_RULES) {
    let score = 0;
    const matched: string[] = [];
    for (const term of terms) {
      // `countOccurrences` rather than a boolean so "fire fire fire" outscores
      // "fire" — a report that repeats a word is describing something that is
      // happening repeatedly, which is real evidence.
      const hits = countOccurrences(text, term);
      if (hits > 0) {
        score += hits;
        matched.push(term);
      }
    }
    for (const term of strong) {
      if (countOccurrences(text, term) > 0) {
        score += 2;
        highSignalHits += 1;
      }
    }
    // Strictly greater, so a tie resolves to the EARLIER category in the table.
    // Deterministic tie-breaking matters: the same report must always produce the
    // same category, or "why did this change?" is unanswerable.
    if (score > bestScore) {
      bestScore = score;
      category = candidate;
      matchedCategoryTerms = matched;
    }
  }

  /* --- urgency: first matching band wins, `low` otherwise --------------- */
  let urgency: Urgency = 'low';
  let matchedUrgencyTerm: string | null = null;
  for (const [band, terms] of URGENCY_TERMS) {
    const hit = terms.find((term) => text.includes(term));
    if (hit !== undefined) {
      urgency = band;
      matchedUrgencyTerm = hit;
      break;
    }
  }

  /* --- confidence: 0.25 base, +0.1 per high-signal term, hard cap ------ */
  const confidence = Math.min(
    FALLBACK_MAX_CONFIDENCE,
    Math.round((BASE_CONFIDENCE + HIGH_SIGNAL_STEP * highSignalHits) * 100) / 100,
  );

  /* --- hazards ---------------------------------------------------------- */
  const hazards = HAZARD_TERMS.filter(([, terms]) =>
    terms.some((term) => text.includes(term)),
  ).map(([hazard]) => hazard);

  /* --- flags ------------------------------------------------------------ */
  // `low_confidence` unconditionally: the cap guarantees it, and stating it
  // explicitly means the flag survives a future change to the banding.
  const flags = new Set<SafetyFlag>(['low_confidence']);
  if (!input.hasCoordinates) flags.add('unclear_location');
  if (urgency === 'critical' || urgency === 'high') flags.add('medical_critical');
  if (hazards.includes('weapon')) flags.add('violence');
  if (hazards.includes('gas_leak')) flags.add('gas_leak');
  if (hazards.includes('fire')) flags.add('fire');
  if (hazards.includes('flood_water')) flags.add('flood_rising');
  if (hazards.includes('structural_risk')) flags.add('injured_trapped');

  // Sorted into the canonical `SAFETY_FLAGS` order, NOT left in `Set` insertion
  // order. `normalizeTriageOutput` does the same, and the reason is that two
  // records with the same flags must render identically: a dispatcher comparing
  // two incidents should not have to re-read a reordered list, and a diff of two
  // `aiRuns` documents should show a change rather than a shuffle. A test caught
  // the inconsistency — the model path sorted and this one did not.
  const safetyFlags = SAFETY_FLAGS.filter((flag) => flags.has(flag));

  /* --- the summary, verbatim from docs/09 §7.2 --------------------------- */
  // It says nothing about the facts on purpose. A fallback summary that claimed
  // "Two people injured near the market" would be asserting a casualty count and
  // a location that a keyword engine has not established.
  const where = input.coarseArea ?? 'an unknown location';
  // `categoryLabel`, not a hand-rolled `replace(/_/g, ' ')`. The config table is
  // where a category's human name lives and the UI reads it from there, so a
  // fallback summary that spelled it differently from the dropdown would be a
  // small, permanent inconsistency on a screen a dispatcher reads under pressure.
  const summary = `Reported ${categoryLabel(category).toLowerCase()} near ${where}. Automated triage only — needs human review.`;

  const unknownFields: AiUnknownField[] = ['people_affected', 'resources'];
  if (!input.hasCoordinates) unknownFields.unshift('location');

  return {
    normalized: {
      category,
      categoryRaw: null,
      urgency,
      summary,
      language: (input.language.split('-')[0] ?? 'en').toLowerCase(),
      // Rule 2 of the two hard rules. Always null.
      locationHint: null,
      landmarks: [],
      // Rule 1 of the two hard rules. Always null.
      peopleAffected: null,
      requiredResources: [],
      safetyFlags,
      hazards,
      audioTranscript: null,
      audioTranscriptUncertain: false,
      confidence,
      unknownFields,
      // True by construction: the cap is 0.55 and the threshold defaults to 0.6.
      // Computed anyway, so raising the threshold or lowering the cap cannot
      // silently produce a fallback that claims to be trustworthy.
      needsReview: confidence < input.reviewThreshold,
      notes: [
        'AI analysis was unavailable, so this record was produced by keyword rules and requires human review.',
      ],
      hallucinationFiltered: false,
    },
    matchedCategoryTerms,
    matchedUrgencyTerm,
  };
}

/**
 * The urgency list, re-exported so `fallback.test.ts` can assert the bands
 * partition the enum rather than re-typing them.
 */
export const FALLBACK_URGENCIES = URGENCIES;

/** The hazard keyword table's coverage, for the test. */
export const FALLBACK_HAZARDS = AI_HAZARDS;
