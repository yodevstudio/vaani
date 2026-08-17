const WILDCARD = '*';

function isWildcard(value) {
  if (value === WILDCARD) return true;
  return Array.isArray(value) && value.includes(WILDCARD);
}

// A slot value may be an imprecise range {min, max} instead of a single
// point — e.g. a citizen who says "पचास-साठ हज़ार" for income. Either bound
// may be null for open-ended ("₹50,000 या अधिक").
function isRangeValue(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && ('min' in v || 'max' in v);
}

// Exported so assemble.js's explainGap (D6) can display a range-valued gap
// (e.g. an age band) the same way this module already formats one in its
// own messages — one implementation, not a second copy.
export function formatRangeValue({ min, max }) {
  if (min !== null && min !== undefined && max !== null && max !== undefined) return `${min}–${max}`;
  if (min !== null && min !== undefined) return `${min}+`;
  if (max !== null && max !== undefined) return `${max} तक`;
  return 'अनिश्चित सीमा';
}

// A `between` condition's value can be written as [min, max] (the original
// synthetic test fixtures, and D2's own convention elsewhere) or {min, max}
// (every real between condition across the 26-scheme merge uses this form).
// Both are legitimate JSON for the same idea, so both must work — schemes.json
// isn't hand-authored by one person on one convention. The -Infinity/Infinity
// fallback only fires for a malformed value (neither array nor object); no
// condition in the current dataset hits it.
export function parseBounds(v) {
  if (Array.isArray(v)) return { min: v[0], max: v[1] };
  if (v && typeof v === 'object') return { min: v.min, max: v.max };
  return { min: -Infinity, max: Infinity };
}

function opLabelFor(op, value) {
  switch (op) {
    case 'in': return `इनमें से एक होना चाहिए: [${value.join(', ')}]`;
    case 'gte': return `>= ${value} होना चाहिए`;
    case 'lte': return `<= ${value} होना चाहिए`;
    case 'eq': return `= ${value} होना चाहिए`;
    case 'between': {
      const { min, max } = parseBounds(value);
      return `[${min}, ${max}] के बीच होना चाहिए`;
    }
    default: throw new Error(`Unknown eligibility operator: ${op}`);
  }
}

function evaluatePointCondition(op, value, actual) {
  switch (op) {
    case 'in': return Array.isArray(value) && value.includes(actual);
    case 'gte': return actual >= value;
    case 'lte': return actual <= value;
    case 'eq': return actual === value;
    case 'between': {
      const { min, max } = parseBounds(value);
      return actual >= min && actual <= max;
    }
    default: throw new Error(`Unknown eligibility operator: ${op}`);
  }
}

// Three-valued: true only if EVERY point in the range satisfies the
// condition, false only if NO point does, 'unknown' if the range straddles
// the threshold — we never guess a midpoint. Open bounds extend to
// +/-Infinity. For eq/in, a range is only ever usable if it has collapsed
// to a single point; otherwise which point the citizen meant is unknowable.
function evaluateRangeCondition(op, value, range) {
  const lo = range.min === null || range.min === undefined ? -Infinity : range.min;
  const hi = range.max === null || range.max === undefined ? Infinity : range.max;

  switch (op) {
    case 'gte':
      if (lo >= value) return true;
      if (hi < value) return false;
      return 'unknown';
    case 'lte':
      if (hi <= value) return true;
      if (lo > value) return false;
      return 'unknown';
    case 'between': {
      const { min: bLo, max: bHi } = parseBounds(value);
      if (bLo === -Infinity && bHi === Infinity) return 'unknown';
      if (lo >= bLo && hi <= bHi) return true;
      if (hi < bLo || lo > bHi) return false;
      return 'unknown';
    }
    case 'eq':
    case 'in': {
      const isPoint = range.min !== null && range.min !== undefined &&
        range.max !== null && range.max !== undefined && range.min === range.max;
      if (!isPoint) return 'unknown';
      const point = range.min;
      return op === 'eq' ? point === value : Array.isArray(value) && value.includes(point);
    }
    default:
      throw new Error(`Unknown eligibility operator: ${op}`);
  }
}

// Every leaf evaluates to true, false, or 'unknown' (slot not supplied, or
// a supplied range too imprecise to decide). 'unknown' must never be
// treated as true or false by a caller — that is the guessing this engine
// exists to prevent.
function evaluateCondition(condition, slots) {
  const { slot, op, value } = condition;
  const hasSlot = slot in slots && slots[slot] !== undefined && slots[slot] !== null;
  const actual = hasSlot ? slots[slot] : null;

  if (isWildcard(value)) {
    return { result: true, missing: null, message: `${slot}: कोई विशेष शर्त नहीं (*)`, condition, actual };
  }

  if (!hasSlot) {
    return { result: 'unknown', missing: slot, message: `${slot}: जानकारी उपलब्ध नहीं`, condition, actual: null };
  }

  const opLabel = opLabelFor(op, value);
  const result = isRangeValue(actual)
    ? evaluateRangeCondition(op, value, actual)
    : evaluatePointCondition(op, value, actual);
  const actualDisplay = isRangeValue(actual) ? formatRangeValue(actual) : actual;
  const missing = result === 'unknown' ? slot : null;

  return { result, missing, message: `${slot}: दिया गया ${actualDisplay}, ${opLabel}`, condition, actual };
}

// An any_of/all_of/none_of entry is either a single {slot,op,value} condition
// or an array of conditions ANDed together (see T01: gender-dependent age
// thresholds can't be expressed as a single flat condition).
function evaluateGroup(entry, slots) {
  const conditions = Array.isArray(entry) ? entry : [entry];
  const leaves = conditions.map((c) => evaluateCondition(c, slots));

  if (leaves.some((l) => l.result === false)) return { result: false, missing: [], leaves };
  if (leaves.every((l) => l.result === true)) return { result: true, missing: [], leaves };
  const missing = leaves.filter((l) => l.result === 'unknown').map((l) => l.missing);
  return { result: 'unknown', missing, leaves };
}

// Three-valued AND ('and': any false wins, ignoring other branches' missing
// slots) / OR ('or': any true wins). Both short-circuit on their decisive
// value so we never ask for a slot that can't change the outcome.
function combine(groupResults, mode) {
  const leaves = groupResults.flatMap((g) => g.leaves);
  const decisive = mode === 'and' ? false : true;

  if (groupResults.some((g) => g.result === decisive)) {
    return { result: decisive, missing: [], leaves };
  }
  if (groupResults.every((g) => g.result === !decisive)) {
    return { result: !decisive, missing: [], leaves };
  }
  const missing = groupResults.filter((g) => g.result === 'unknown').flatMap((g) => g.missing);
  return { result: 'unknown', missing, leaves };
}

function formatReason(leaf, kind) {
  if (leaf.result === 'unknown') return `${leaf.message} — जानकारी चाहिए`;
  if (kind === 'requirement') return `${leaf.message} — ${leaf.result ? 'शर्त पूरी' : 'शर्त असफल'}`;
  return `${leaf.message} — ${leaf.result ? 'अपवर्जन शर्त लागू (अपात्र)' : 'अपवर्जन लागू नहीं (ठीक)'}`;
}

// A leaf blocks eligibility differently depending on which group it came
// from: a requirement leaf (all_of/any_of) blocks when it's false (the
// condition wasn't met); an exclusion leaf (none_of) blocks when it's true
// (the disqualifying condition WAS matched) — same polarity flip as
// formatReason above. 'unknown' leaves are never gaps; they're missing_slots.
function toGaps(leaves, kind) {
  const blocks = kind === 'exclusion' ? (l) => l.result === true : (l) => l.result === false;
  return leaves.filter(blocks).map((l) => ({
    slot: l.condition.slot,
    op: l.condition.op,
    required: l.condition.value,
    actual: l.actual,
    kind,
  }));
}

export function evaluate(slots, scheme) {
  const safeSlots = slots || {};
  const eligibility = (scheme && scheme.eligibility) || {};
  const allOf = eligibility.all_of || [];
  const anyOf = eligibility.any_of || [];
  const noneOf = eligibility.none_of || [];

  const allOfResult = allOf.length === 0
    ? { result: true, missing: [], leaves: [] }
    : combine(allOf.map((e) => evaluateGroup(e, safeSlots)), 'and');

  const anyOfResult = anyOf.length === 0
    ? { result: true, missing: [], leaves: [] }
    : combine(anyOf.map((e) => evaluateGroup(e, safeSlots)), 'or');

  // none_of passes when NONE of its entries hold, i.e. NOT(OR(entries)).
  const noneOfOr = noneOf.length === 0
    ? { result: false, missing: [], leaves: [] }
    : combine(noneOf.map((e) => evaluateGroup(e, safeSlots)), 'or');
  const noneOfResult = noneOfOr.result === 'unknown'
    ? { result: 'unknown', missing: noneOfOr.missing, leaves: noneOfOr.leaves }
    : { result: !noneOfOr.result, missing: [], leaves: noneOfOr.leaves };

  const final = combine([allOfResult, anyOfResult, noneOfResult], 'and');

  const verdict = final.result === true
    ? 'ELIGIBLE'
    : final.result === false
      ? 'NOT_ELIGIBLE'
      : 'NEED_MORE_INFO';

  const reasons = [
    ...allOfResult.leaves.map((l) => formatReason(l, 'requirement')),
    ...anyOfResult.leaves.map((l) => formatReason(l, 'requirement')),
    ...noneOfResult.leaves.map((l) => formatReason(l, 'exclusion')),
  ];

  const gaps = [
    ...toGaps(allOfResult.leaves, 'requirement'),
    ...toGaps(anyOfResult.leaves, 'requirement'),
    ...toGaps(noneOfResult.leaves, 'exclusion'),
  ];

  return { verdict, reasons, missing_slots: [...new Set(final.missing)], gaps };
}

// Batch form of evaluate() — every screen that needs a full eligibility
// breakdown across the catalogue (operator table, print checklist,
// discovery results) shares this one implementation, so they can never
// disagree about what "evaluate everything against these slots" means.
export function evaluateAll(slots, schemes) {
  return (schemes || []).map((scheme) => ({ scheme, evaluation: evaluate(slots, scheme) }));
}
