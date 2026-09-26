/**
 * ============================================================================
 * CareGrid AI — reverse CP1252 mojibake in source files
 * ============================================================================
 *
 * WHAT WENT WRONG
 * ---------------
 * A PowerShell `Get-Content -Raw` + `Set-Content -Encoding utf8` round trip reads
 * a file using the ANSI (CP1252) codepage and writes the result back as UTF-8.
 * Every multi-byte character becomes 2–3 mojibake characters: an em dash
 * (U+2014, bytes E2 80 94) turns into `â€”` (U+00E2 U+20AC U+201D), and a
 * section sign (U+00A7) into `Â§`.
 *
 * HOW TO REVERSE IT
 * -----------------
 * Map each mojibake code point BACK to its CP1252 byte using the real CP1252
 * high block, then decode those bytes as UTF-8.
 *
 * `Buffer.from(text, 'latin1')` does NOT work: it truncates to the low byte, so
 * U+20AC becomes 0xAC instead of 0x80 and the em dash decodes to garbage. That
 * is why two earlier attempts matched but produced nothing usable.
 *
 * SAFETY
 * ------
 * The pattern only matches runs that begin with a tell-tale lead-byte character
 * (U+00C2, U+00E2, ...) followed by CP1252 continuation characters, and a run is
 * accepted only when the decode yields valid, different text containing no
 * replacement character. Correctly-encoded text is left byte-identical, so this
 * is safe to run over the whole tree.
 *
 * USAGE
 * -----
 *   node scripts/repair-encoding.cjs                # dry run, lists the files
 *   node scripts/repair-encoding.cjs --write <files> # apply
 *   node scripts/repair-encoding.cjs --write .       # apply to a whole tree
 *
 * Exit code is 1 when damage is found and `--check` is used, so it can be wired
 * into CI as a guard against the PowerShell round trip happening again.
 */

'use strict';

const { readFileSync, writeFileSync, readdirSync, statSync } = require('node:fs');
const { join, extname } = require('node:path');

/** CP1252 bytes 0x80–0x9F and the code points they map to. */
const CP1252_HIGH = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
};

/** code point → CP1252 byte. */
const REVERSE = new Map();
for (const [byte, codePoint] of Object.entries(CP1252_HIGH)) {
  REVERSE.set(codePoint, Number(byte));
}
// U+0000–U+00FF map to themselves.
for (let c = 0; c <= 0xff; c += 1) REVERSE.set(c, c);

/** Characters that can begin a mojibake run (a CP1252-mapped UTF-8 lead byte). */
const LEAD = new Set([
  0x00c2, 0x00c3, 0x00c4, 0x00c5, 0x00e0, 0x00e1, 0x00e2, 0x00e3,
  0x00e4, 0x00e5, 0x00e8, 0x00e9, 0x00ea, 0x00eb, 0x00ec, 0x00ed, 0x00ee, 0x00ef,
  0x00f1, 0x00f2, 0x00f3,
]);

/** Characters that can continue a run. */
const TRAIL = new Set(REVERSE.keys());
// The second byte of a 3-byte UTF-8 sequence, which CP1252 maps into U+20xx.
for (let c = 0x2000; c <= 0x20ff; c += 1) TRAIL.add(c);

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.css', '.mjs', '.js', '.json', '.md']);

/** Decode one mojibake run, or return null when it is not one. */
function decodeRun(run) {
  const bytes = [];
  for (const ch of run) {
    const byte = REVERSE.get(ch.codePointAt(0));
    if (byte === undefined) return null;
    bytes.push(byte);
  }
  const decoded = Buffer.from(bytes).toString('utf8');
  if (decoded === run) return null;
  // A valid decode must not contain a replacement character.
  if (decoded.includes('�')) return null;
  return decoded;
}

/** Replace every maximal mojibake run in `text`. */
function repair(text) {
  let out = '';
  let i = 0;
  let changed = 0;

  while (i < text.length) {
    const ch = text[i];
    const code = ch.codePointAt(0);

    if (LEAD.has(code) && i + 1 < text.length) {
      // Greedily take lead + up to two continuation characters.
      let run = ch;
      let consumed = 1;
      while (consumed < 3 && i + consumed < text.length) {
        const next = text[i + consumed].codePointAt(0);
        if (!TRAIL.has(next)) break;
        run += text[i + consumed];
        consumed += 1;
      }
      const decoded = decodeRun(run);
      if (decoded !== null) {
        out += decoded;
        changed += 1;
        i += consumed;
        continue;
      }
    }

    out += ch;
    i += 1;
  }

  return { out, changed };
}

function collectFiles(target) {
  let stats;
  try {
    stats = statSync(target);
  } catch {
    return [];
  }
  if (stats.isFile()) return SOURCE_EXTENSIONS.has(extname(target)) ? [target] : [];

  const found = [];
  for (const entry of readdirSync(target)) {
    if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue;
    found.push(...collectFiles(join(target, entry)));
  }
  return found;
}

const argv = process.argv.slice(2);
const apply = argv.includes('--write');
const check = argv.includes('--check');
const targets = argv.filter((arg) => !arg.startsWith('--'));

if (targets.length === 0) {
  console.error('Usage: node scripts/repair-encoding.cjs [--write] [--check] <file-or-dir...>');
  process.exit(2);
}

let damagedFiles = 0;
let totalRuns = 0;

for (const target of targets) {
  for (const file of collectFiles(target)) {
    const original = readFileSync(file, 'utf8');
    const { out, changed } = repair(original);
    if (changed === 0) continue;
    damagedFiles += 1;
    totalRuns += changed;
    console.log(`${String(changed).padStart(3)} run(s)  ${file}`);
    if (apply) writeFileSync(file, out, 'utf8');
  }
}

console.log(
  `\n${totalRuns} run(s) in ${damagedFiles} file(s) ${apply ? 'repaired' : 'would be repaired'}.`,
);

if (check && damagedFiles > 0) {
  console.error('Mojibake found. Run with --write to repair.');
  process.exit(1);
}
