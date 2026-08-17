// PRODUCTION NOTE: in deployment this module is replaced by an LLM router
// constrained to schema-validated JSON output ({intent, scheme_ids, slots,
// confidence}). It never emits prose or currency figures. This deterministic
// implementation is the demo path and the production fallback when the
// model is unavailable.

export const CONFIDENCE_THRESHOLD = 0.55;

// Score at/above which a single scheme's keyword-match strength saturates
// to full confidence (before any tie/close-second penalty is applied).
const SATURATION = 20;

const WORD_CHAR_CLASS = '\\u0900-\\u097F0-9A-Za-z-';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function indexOfPhrase(text, phrase) {
  if (!phrase) return -1;
  const pattern = new RegExp(`(?<![${WORD_CHAR_CLASS}])${escapeRegExp(phrase)}(?![${WORD_CHAR_CLASS}])`);
  const m = pattern.exec(text);
  return m ? m.index : -1;
}

function containsPhrase(text, phrase) {
  return indexOfPhrase(text, phrase) !== -1;
}

// Phrases a citizen uses to ask "what am I entitled to" rather than name a
// specific scheme — hand-picked, not a generalised classifier, same
// discipline as the lexicon: only phrases we're confident are genuine.
export const DISCOVERY_PHRASES = [
  'क्या मिल सकता है',
  'कांई-कांई',
  'कांई मिलै',
  'कोई योजना',
  'मेरे लायक',
  'म्हारे लायक',
  'हक',
  'क्या-क्या',
  'कौन सी योजना',
  'फायदा',
  'लाभ',
];

function isDiscoveryQuery(text) {
  return DISCOVERY_PHRASES.some((phrase) => containsPhrase(text, phrase));
}

// When two terms from the same slot's dictionary both appear (e.g. a
// sentence mentions a scheme name containing "विधवा" as well as a citizen's
// own "तलाकशुदा" self-description), the later-occurring one wins — treated
// as the more specific, most-recently-stated fact, not whichever term
// happened to be declared first in the dictionary below.
function extractLastMatch(text, termList) {
  let best = null;
  for (const [term, value] of termList) {
    const idx = indexOfPhrase(text, term);
    if (idx !== -1 && (best === null || idx > best.idx)) best = { idx, value };
  }
  return best ? best.value : null;
}

// Each matched keyword contributes a flat base score (curated keywords are
// deliberately chosen, distinguishing phrases — a single hit is meaningful
// signal, not noise) plus a small length bonus for extra specificity.
// A full name_hi match adds a further bonus on top of its own base score.
function scoreScheme(text, scheme) {
  let score = 0;
  const matched = [];
  const candidates = [
    { term: scheme.name_hi, bonus: 10 },
    ...((scheme.keywords_hi || []).map((k) => ({ term: k, bonus: 0 }))),
  ];
  for (const { term, bonus } of candidates) {
    if (term && containsPhrase(text, term)) {
      score += 10 + Math.min(term.length, 10) + bonus;
      matched.push(term);
    }
  }
  return { score, matched };
}

const DEVANAGARI_DIGITS = '०१२३४५६७८९';

function devanagariToLatinDigits(str) {
  return str.replace(/[०-९]/g, (d) => String(DEVANAGARI_DIGITS.indexOf(d)));
}

const AGE_WORD = '(?:साल|वर्ष|बरस)';
const AGE_PATTERNS = [
  new RegExp(`(\\d{1,3})\\s*${AGE_WORD}`),
  new RegExp(`${AGE_WORD}\\s*(\\d{1,3})`),
];

function extractAge(text) {
  const digitText = devanagariToLatinDigits(text);
  for (const pattern of AGE_PATTERNS) {
    const m = digitText.match(pattern);
    if (m) {
      const age = parseInt(m[1], 10);
      if (age > 0 && age < 120) return age;
    }
  }
  return null;
}

const GENDER_TERMS = [
  ['महिला', 'female'],
  ['स्त्री', 'female'],
  ['औरत', 'female'],
  ['पुरुष', 'male'],
  ['आदमी', 'male'],
  ['मर्द', 'male'],
];

function extractGender(text) {
  return extractLastMatch(text, GENDER_TERMS);
}

const MARITAL_TERMS = [
  ['विधवा', 'widow'],
  ['तलाकशुदा', 'divorced'],
  ['परित्यक्ता', 'abandoned'],
  ['अविवाहित', 'unmarried'],
  ['विवाहित', 'married'],
];

function extractMaritalStatus(text) {
  return extractLastMatch(text, MARITAL_TERMS);
}

const OCCUPATION_TERMS = [
  ['किसान', 'farmer'],
  ['मजदूर', 'labourer'],
  ['विद्यार्थी', 'student'],
  ['बेरोजगार', 'unemployed'],
];

function extractOccupation(text) {
  return extractLastMatch(text, OCCUPATION_TERMS);
}

// Long-stable 33-district set (pre-2023 reorganisation). Rajasthan's
// district boundaries were reorganised in 2023 and partially reverted in
// 2024 — update this list if the state finalises a new district map.
// Exported so app.js's discovery flow can build district_select options
// from this same list, not a second copy.
export const RAJASTHAN_DISTRICTS = [
  'अजमेर', 'अलवर', 'बांसवाड़ा', 'बारां', 'बाड़मेर', 'भरतपुर', 'भीलवाड़ा', 'बीकानेर', 'बूंदी',
  'चित्तौड़गढ़', 'चूरू', 'दौसा', 'धौलपुर', 'डूंगरपुर', 'हनुमानगढ़', 'जयपुर', 'जैसलमेर', 'जालौर',
  'झालावाड़', 'झुंझुनू', 'जोधपुर', 'करौली', 'कोटा', 'नागौर', 'पाली', 'प्रतापगढ़', 'राजसमंद',
  'सवाई माधोपुर', 'सीकर', 'सिरोही', 'श्रीगंगानगर', 'टोंक', 'उदयपुर',
].sort((a, b) => b.length - a.length);

function extractDistrict(text) {
  return extractLastMatch(text, RAJASTHAN_DISTRICTS.map((d) => [d, d]));
}

function extractSlots(text) {
  const slots = {};
  const age = extractAge(text);
  if (age !== null) slots.age = age;
  const gender = extractGender(text);
  if (gender) slots.gender = gender;
  const marital_status = extractMaritalStatus(text);
  if (marital_status) slots.marital_status = marital_status;
  const occupation = extractOccupation(text);
  if (occupation) slots.occupation = occupation;
  const district = extractDistrict(text);
  if (district) slots.district = district;
  return slots;
}

export function route(normalisedText, schemes) {
  const text = normalisedText || '';
  const list = schemes || [];
  const slots = extractSlots(text);

  const scored = list
    .map((scheme) => ({ scheme, ...scoreScheme(text, scheme) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  let confidence = 0;
  let top = [];
  if (scored.length > 0) {
    const maxScore = scored[0].score;
    top = scored.filter((s) => s.score === maxScore);
    const runnerUp = scored.find((s) => s.score < maxScore);
    const secondScore = runnerUp ? runnerUp.score : 0;

    const rawStrength = Math.min(1, maxScore / SATURATION);

    if (top.length > 1) {
      // Genuine tie between two or more schemes — never confident.
      confidence = Math.min(rawStrength, 0.4);
    } else if (secondScore > 0 && secondScore / maxScore > 0.7) {
      // A close second-best candidate makes the top match less trustworthy.
      confidence = rawStrength * 0.6;
    } else {
      confidence = rawStrength;
    }
    confidence = Math.round(confidence * 100) / 100;
  }

  const confidentSingleMatch = confidence >= CONFIDENCE_THRESHOLD && top.length === 1;

  // "What am I entitled to" beats "I don't recognise that" — but a named
  // scheme always wins over a general browse request, even if the
  // utterance also contains a discovery phrase ("तारबंदी के बारे में क्या
  // मिल सकता है" is about Tarbandi, not a request to browse everything).
  // PRODUCTION NOTE: the LLM router emits this same `discover` intent from
  // the same schema — {intent, scheme_ids, slots, confidence} — when it
  // classifies a browse-style question rather than a named scheme.
  if (!confidentSingleMatch && isDiscoveryQuery(text)) {
    return { intent: 'discover', scheme_ids: [], slots, confidence: 1 };
  }

  if (scored.length === 0) {
    return { intent: 'unknown', scheme_ids: [], slots, confidence: 0 };
  }

  const scheme_ids = confidentSingleMatch
    ? [top[0].scheme.scheme_id]
    : scored.slice(0, 2).map((s) => s.scheme.scheme_id);

  return { intent: 'scheme_query', scheme_ids, slots, confidence };
}
