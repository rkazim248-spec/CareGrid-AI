/**
 * ============================================================================
 * CareGrid AI — duplicate detection: text similarity
 * ============================================================================
 *
 * `docs/07 §9.4` Gate 3. **PURE.** No Firestore, no env, no clock.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TEXT SIGNAL IS WEIGHED HIGHEST AND STILL CANNOT DECIDE ALONE
 * ---------------------------------------------------------------------------
 * The weights in `score.ts` are 0.35 distance / 0.10 time / 0.25 category /
 * 0.30 text. Text is the heaviest single signal, which is right: two reports 150 m
 * apart describing "car accident" and "car crash" are the same event far more
 * often than two reports at the same spot describing different things.
 *
 * But `classifyDuplicate` never auto-merges. `docs/07 §9.4` rule 1 is explicit:
 * `confirmed_duplicate` is **a suggestion surfaced to a human**, and the incident is
 * always created. This is brief §19 and §27 restated: two reports 200 m apart — a
 * road accident and a building fire — may be two different incidents, and the
 * system says "potential nearby incident", never "merged".
 *
 * ---------------------------------------------------------------------------
 * WHY JACCARD AND NOT COSINE OR LEVENSHTEIN
 * ---------------------------------------------------------------------------
 * Jaccard is `|A n B| / |A ? B|`, and it has the two properties that matter for
 * short emergency descriptions:
 *
 *  1. **It is invariant to repetition.** "fire" and "fire fire fire" produce the
 *     same set, so a citizen who repeats a word to emphasise it gains no
 *     similarity. Short emergency text is repetitive — "help", "fire", "now" — and
 *     a metric that counted repetitions would rank a panic-stricken report as
 *     unusually distinctive.
 *  2. **It is O(n + m)** and needs no vocabulary, so a typo or an unusual word
 *     cannot push one report away from another.
 *
 * Its one real weakness is **dilution**: a 40-word report about the same crash
 * padded with 40 unrelated words scores 4/44 ˜ 0.09 against a 4-word report of
 * that crash. That is CORRECT behaviour — the padding genuinely is not about the
 * same event — and it is why the token cap is 60 rather than unlimited, and why
 * the decision never rests on text alone. (An earlier version of this comment
 * claimed Jaccard was "scale-invariant", which is false; the test that corrected
 * it is "DILUTES when unrelated tokens are added, which is correct".)
 */

/**
 * The 60-word English stopword list. `docs/07 §9.5`.
 *
 * **Not a general-purpose list.** It is short and deliberately omits words that are
 * meaningful in an emergency: "fire", "help", "trapped", "missing", "under", "over".
 * A standard NLP stopword list contains "over" and "under", and dropping them would
 * destroy exactly the distinctions that separate a fire from a flood from a
 * collapse. A token that carries information about the incident is not a stopword
 * for this product, however common it is in English.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'doing', 'for', 'from', 'had', 'has',
  'have', 'having', 'he', 'her', 'here', 'hers', 'him', 'his', 'how', 'i',
  'if', 'in', 'into', 'is', 'it', 'its', 'just', 'may', 'me', 'might', 'mine',
  'must', 'my', 'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'only',
  'or', 'other', 'our', 'ours', 'out', 'own', 'said', 'same', 'shall', 'she',
  'should', 'so', 'some', 'such', 'than', 'that', 'the', 'their', 'theirs',
  'them', 'then', 'there', 'these', 'they', 'this', 'those', 'to', 'too', 'up',
  'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who',
  'whom', 'why', 'will', 'with', 'would', 'you', 'your', 'yours',
]);

/**
 * The token cap. `docs/07 §9.4`: "cap at 60 tokens each".
 *
 * Caps **both** reports at the same length, which keeps Jaccard symmetric — a
 * 400-word report and a 5-word one are not made artificially similar by the longer
 * one's extra vocabulary. The first 60 tokens are kept, so a citizen who writes
 * "there is a fire and also some other unrelated detail …" for three paragraphs is
 * compared on the part that describes the emergency.
 */
export const MAX_TOKENS = 60;

/**
 * `docs/07 §9.4`'s `normTokens`, verbatim in behaviour.
 *
 * lowercase ? strip punctuation ? drop stopwords and digits-only tokens ?
 * collapse whitespace ? cap at 60.
 *
 * **Punctuation is replaced with a space, not deleted.** Deleting it would fuse
 * adjacent words across the punctuation ("fire,trapped" ? "firetrapped"), which
 * is a single token matching nothing. Replacing with a space keeps them separate.
 *
 * Returns a `Set`, because the caller computes an intersection and a union and a
 * duplicate token in an array would inflate both. A report saying "fire fire fire"
 * is one signal, not three.
 */
export function normalizeTokens(text: string | null | undefined): Set<string> {
  if (typeof text !== 'string' || text.length === 0) return new Set();

  const cleaned = text
    .toLowerCase()
    // A space, not ''. See the comment above.
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length === 0) return new Set();

  const tokens: string[] = [];
  for (const raw of cleaned.split(' ')) {
    if (raw.length === 0) continue;
    // Digits-only tokens are dropped. "5" and "9" are house numbers and times, and
    // two reports of the same fire are unlikely to share them; keeping them would
    // make almost nothing similar to anything else.
    if (/^\d+$/.test(raw)) continue;
    if (STOPWORDS.has(raw)) continue;
    tokens.push(raw);
    if (tokens.length >= MAX_TOKENS) break;
  }

  return new Set(tokens);
}

/**
 * Jaccard similarity, 0..1. `docs/07 §9.4` Gate 3.
 *
 * **Two empty sets return 0, not 1.** This is the single most consequential
 * decision in the file and `docs/07 §9.5` names the case:
 * "empty text (audio-only) ? falls back to category+distance only".
 *
 * Returning 1 would make an audio-only report and a text report with no
 * distinguishable tokens score as *identical text*, and the 0.30 text weight would
 * fire — so two reports that share nothing but a location would be pushed over the
 * potential-duplicate threshold by a signal that does not exist. Returning 0 is the
 * honest answer: no evidence either way, so the score falls back to distance,
 * category and time, which is what the specification says it should.
 */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;

  let intersection = 0;
  // Iterating the smaller set: the result is identical and the cost is O(min).
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of small) {
    if (large.has(token)) intersection += 1;
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * The up-to-10 shared tokens with the highest weight, for the stored breakdown.
 *
 * **Sorted by length, then alphabetically.** A naive `sort()` on the tokens
 * themselves would put "a" before "accident" for no reason a reader could infer;
 * longest-first surfaces the substantive words, and the alphabetical tiebreak makes
 * the output deterministic — `DuplicateBreakdown` is persisted, and a
 * non-deterministic key order would make two runs over the same data produce
 * different documents.
 */
export function topOverlapTokens(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
  limit = 10,
): string[] {
  const overlap: string[] = [];
  for (const token of a) {
    if (b.has(token)) overlap.push(token);
  }
  overlap.sort((x, y) => (y.length - x.length) || x.localeCompare(y));
  return overlap.slice(0, limit);
}
