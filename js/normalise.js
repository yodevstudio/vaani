const LEXICON_STORAGE_KEY = 'vaani.lexicon.v1';

// JS \b relies on \w (ASCII only) and never matches inside Devanagari text,
// so word boundaries here are detected manually against the actual script range.
const WORD_CHAR_CLASS = '\\u0900-\\u097F0-9A-Za-z-';
const NOT_WORD_CHAR = new RegExp(`^[^${WORD_CHAR_CLASS}]$`);

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findMatches(raw, key) {
  const pattern = new RegExp(
    `(?<![${WORD_CHAR_CLASS}])${escapeRegExp(key)}(?![${WORD_CHAR_CLASS}])`,
    'g'
  );
  const matches = [];
  let m;
  while ((m = pattern.exec(raw)) !== null) {
    matches.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    if (pattern.lastIndex === m.index) pattern.lastIndex += 1;
  }
  return matches;
}

/**
 * Pure function: normalise dialect text against a lexicon map.
 * Longest keys are tried first so multi-word phrases win over the
 * shorter single words they contain (e.g. "बुढ़ापा री पिंडोळी" over "पिंडोळी").
 */
export function normalise(text, lexicon) {
  const raw = text == null ? '' : String(text);
  const map = (lexicon && lexicon.map) || lexicon || {};
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);

  const claimed = [];
  const found = [];

  for (const key of keys) {
    if (!key) continue;
    for (const match of findMatches(raw, key)) {
      const overlapsClaimed = claimed.some(
        (r) => match.start < r.end && match.end > r.start
      );
      if (!overlapsClaimed) {
        claimed.push({ start: match.start, end: match.end });
        found.push({ start: match.start, end: match.end, from: match.text, to: map[key] });
      }
    }
  }

  found.sort((a, b) => a.start - b.start);

  let normalised = '';
  let cursor = 0;
  const substitutions = [];
  for (const f of found) {
    normalised += raw.slice(cursor, f.start);
    normalised += f.to;
    substitutions.push({ from: f.from, to: f.to, index: f.start });
    cursor = f.end;

    // A lexicon value that's itself a phrase (e.g. तारबंदी -> तारबंदी योजना)
    // can insert a trailing word the citizen's own text already had right
    // after the matched key ("तारबंदी योजना चाहिए" -> "तारबंदी योजना योजना
    // चाहिए"). Collapse exactly the one duplicate immediately following
    // THIS substitution, once — never a general dedup of repeated words
    // elsewhere in the sentence, and never more than the single word we
    // just inserted actually accounts for.
    const trailingWord = (f.to.match(/(\S+)\s*$/) || [])[1];
    if (trailingWord) {
      const afterMatch = raw.slice(cursor).match(/^(\s*)(\S+)/);
      if (afterMatch && afterMatch[2] === trailingWord) {
        cursor += afterMatch[0].length;
      }
    }
  }
  normalised += raw.slice(cursor);

  return { raw, normalised, substitutions };
}

export async function loadLexicon() {
  const response = await fetch('data/lexicon.json');
  const lexicon = await response.json();
  localStorage.setItem(LEXICON_STORAGE_KEY, JSON.stringify(lexicon));
  return lexicon;
}
