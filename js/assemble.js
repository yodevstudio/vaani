import { evaluate, formatRangeValue, parseBounds } from './eligibility.js';

// Hindi labels for internal slot identifiers — used only to render which
// piece of information is missing or which condition failed. Not scheme
// data: these are fixed UI vocabulary, not a source of numbers or claims.
const SLOT_LABELS_HI = {
  age: 'आयु',
  child_age: 'बच्चे की आयु',
  gender: 'लिंग',
  marital_status: 'वैवाहिक स्थिति',
  annual_income: 'वार्षिक आय',
  residency_years: 'राजस्थान में निवास के वर्ष',
  child_status: 'बच्चे की स्थिति',
  disability_pct: 'निशक्तता प्रतिशत',
  category: 'श्रेणी',
  birth_date: 'जन्म तिथि',
  birth_facility_type: 'जन्म स्थान',
  family_girls_count: 'परिवार में बालिकाओं की संख्या',
  occupation: 'व्यवसाय',
  landholding_hectares: 'भूमि (हेक्टेयर में)',
  group_farmer_count: 'समूह में कृषकों की संख्या',
  group_landholding_hectares: 'समूह की भूमि (हेक्टेयर में)',
  education_level: 'शिक्षा स्तर',
  employment_registered: 'रोजगार कार्यालय पंजीकरण',
  district: 'जिला',
  health_cover_category: 'श्रेणी (निःशुल्क या प्रीमियम पर)',
  // The remaining slots data/slots.json defines for the 26-scheme merge —
  // labels drawn from that file's own question_hi, not invented separately,
  // so a missing-slot/gap prompt never falls back to raw snake_case.
  exam_passed: 'पास की गई परीक्षा',
  employment_sector: 'रोजगार क्षेत्र',
  religion: 'धर्म',
  is_income_tax_payer: 'आयकर भुगतान',
  owns_pucca_house: 'पक्के मकान का स्वामित्व',
  residence_type: 'निवास प्रकार (गाँव/शहर)',
  willing_to_do_unskilled_manual_work: 'मज़दूरी हेतु तैयारी',
  pregnancy_status: 'गर्भावस्था स्थिति',
  pregnancy_child_number: 'गर्भावस्था में बच्चे का क्रम',
  remarriage_status: 'पुनर्विवाह स्थिति',
  widow_pension_recipient_or_eligible: 'विधवा पेंशन प्राप्ति/पात्रता',
  bocw_board_registered: 'श्रमिक कल्याण बोर्ड पंजीयन',
  construction_work_days_last_year: 'पिछले वर्ष निर्माण कार्य के दिन',
  silicosis_certified: 'सिलिकोसिस प्रमाणन',
  residence_distance_from_crusher_km: 'क्रशर से घर की दूरी',
  hospitalization_hours: 'अस्पताल भर्ती की अवधि',
  farmer_loan_status: 'फसल ऋण (KCC) स्थिति',
  group_type: 'समूह प्रकार',
  marks_percent_board_exam: 'बोर्ड परीक्षा में प्रतिशत अंक',
  marks_percent_10_or_12: 'दसवीं/बारहवीं में प्रतिशत अंक',
  has_regular_income_source: 'नियमित आय स्रोत',
  landholding_category: 'भूमि जोत श्रेणी',
  other_social_security_pension_recipient: 'अन्य सामाजिक सुरक्षा पेंशन प्राप्ति',
  monthly_family_income: 'मासिक पारिवारिक आय',
  monthly_income: 'मासिक आय',
  irrigated_land_acres: 'सिंचित भूमि (एकड़ में)',
  kcc_limit_inr: 'किसान क्रेडिट कार्ड सीमा',
  owns_non_agri_enterprise: 'गैर-कृषि व्यवसाय का स्वामित्व',
  household_has_lpg_connection: 'घर में गैस कनेक्शन',
  household_poor_declaration: 'परिवार की गरीबी श्रेणी घोषणा',
  ration_card_category: 'राशन कार्ड श्रेणी',
  visited_government_health_facility: 'सरकारी स्वास्थ्य केंद्र में उपचार',
  is_state_government_pensioner: 'राज्य सरकार पेंशनभोगी स्थिति',
  is_dependent_of_rghs_beneficiary: 'RGHS लाभार्थी का आश्रित होना',
  pension_monthly_inr: 'मासिक पेंशन राशि',
};

function labelFor(slot) {
  return SLOT_LABELS_HI[slot] || slot;
}

function joinHi(labels) {
  if (labels.length === 0) return null;
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} और ${labels[labels.length - 1]}`;
}

function fillTemplate(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => (key in values ? String(values[key]) : ''));
}

// amount_inr is the only field allowed to produce a bare numeric figure; it
// is null on every real scheme today, so this falls through to the verified
// descriptive text. If neither is present there is nothing safe to say.
function getBenefitText(scheme) {
  const benefit = scheme.benefit || {};
  if (typeof benefit.amount_inr === 'number') return `₹${benefit.amount_inr}`;
  if (benefit.amount_text_hi) return benefit.amount_text_hi;
  return null;
}

function formatMissing(missingSlots) {
  return joinHi([...new Set((missingSlots || []).map(labelFor))]) || 'कुछ जानकारी';
}

// eligibility.js's reasons are formatted as "<slot>: ...". Pull the slot
// out of whichever reasons were marked as failed/excluded and translate
// them to a label — never repeat the raw citizen-supplied numbers that
// reason string may contain.
function formatFailureReason(reasons) {
  const failMarkers = ['शर्त असफल', 'अपवर्जन शर्त लागू'];
  const slots = (reasons || [])
    .filter((r) => failMarkers.some((marker) => r.includes(marker)))
    .map((r) => {
      const m = r.match(/^(\S+):/);
      return m ? labelFor(m[1]) : null;
    })
    .filter(Boolean);
  return joinHi([...new Set(slots)]) || 'कुछ शर्तें';
}

function buildUnknown(templates) {
  const text_hi = (templates && templates.unknown)
    || 'मेरे पास इसकी पक्की जानकारी नहीं है। नज़दीकी ई-मित्र से पूछें।';
  return { text_hi, speech_hi: text_hi, citation: null, documents: [] };
}

// Throws if the assembled text contains a digit sequence that cannot be
// traced back to the scheme's benefit fields (or, for explainGap below,
// its eligibility thresholds / the citizen's own stated value). This is
// the anti-hallucination guarantee: the system must be physically unable
// to speak an unverified number. The default allowlist is deliberately
// narrow — amount_inr, amount_text_hi, name_hi, and now a serialisation of
// eligibility (needed because explainGap names threshold figures that live
// there, not in benefit) — so that unrelated fields like dataset_version
// or last_verified can never launder a figure into speech. `extraAllowlist`
// exists ONLY for explainGap to add the one specific gap.actual value it's
// about to echo back to the citizen (their own already-confirmed answer,
// not a new claim) — callers must not use it to re-widen this to the whole
// record. Matches Devanagari digits (०-९) as well as Latin ones, since a
// fabricated figure could be written in either script.
export function assertNoUnsourcedNumber(output, scheme, extraAllowlist) {
  const benefit = (scheme && scheme.benefit) || {};
  const allowlist = [
    typeof benefit.amount_inr === 'number' ? String(benefit.amount_inr) : '',
    benefit.amount_text_hi || '',
    (scheme && scheme.name_hi) || '',
    scheme && scheme.eligibility ? JSON.stringify(scheme.eligibility) : '',
    ...(extraAllowlist || []),
  ].join(' | ');

  for (const field of [output.text_hi, output.speech_hi]) {
    const digitSequences = (field || '').match(/[\d०-९]+/g) || [];
    for (const seq of digitSequences) {
      if (!allowlist.includes(seq)) {
        throw new Error(
          `assertNoUnsourcedNumber: "${seq}" is not traceable to an allowlisted benefit field on scheme ${scheme && scheme.scheme_id}`
        );
      }
    }
  }
  return true;
}

// evaluation is eligibility.js's evaluate() output: { reasons, missing_slots }.
export function assemble(verdict, scheme, evaluation) {
  const templates = (scheme && scheme.response_templates_hi) || {};

  if (!scheme || !scheme.source_url) {
    return buildUnknown(templates);
  }

  const citation = {
    url: scheme.source_url,
    last_verified: scheme.last_verified || null,
    next_review_due: scheme.next_review_due || null,
  };
  const missing_slots = (evaluation && evaluation.missing_slots) || [];
  const reasons = (evaluation && evaluation.reasons) || [];

  let output;

  if (verdict === 'ELIGIBLE') {
    const benefitText = getBenefitText(scheme);
    if (benefitText === null || !templates.eligible) return buildUnknown(templates);
    const text_hi = fillTemplate(templates.eligible, {
      scheme_name_hi: scheme.name_hi || '',
      benefit_text: benefitText,
    });
    output = { text_hi, speech_hi: text_hi, citation, documents: scheme.documents || [] };
  } else if (verdict === 'NEED_MORE_INFO') {
    if (!templates.need_info) return buildUnknown(templates);
    const text_hi = fillTemplate(templates.need_info, {
      scheme_name_hi: scheme.name_hi || '',
      missing: formatMissing(missing_slots),
    });
    output = { text_hi, speech_hi: text_hi, citation, documents: [] };
  } else if (verdict === 'NOT_ELIGIBLE') {
    if (!templates.not_eligible) return buildUnknown(templates);
    const text_hi = fillTemplate(templates.not_eligible, {
      reason_hi: formatFailureReason(reasons),
    });
    output = { text_hi, speech_hi: text_hi, citation, documents: [] };
  } else {
    return buildUnknown(templates);
  }

  assertNoUnsourcedNumber(output, scheme);
  return output;
}

// ===== D6: "why not" / near-miss =====

function formatGapValue(value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && ('min' in value || 'max' in value)) {
    return formatRangeValue(value);
  }
  return String(value);
}

// Correct Hindi grammatical gender for "होनी/होना चाहिए" — scoped to only
// the slots that actually carry gte/lte/between conditions in this
// dataset (see data/schemes.json). Slots not listed here never reach the
// branches that call this (age/annual_income are special-cased before it;
// eq/in/exclusion phrasing below avoids होना/होनी entirely).
const GAP_SLOT_GENDER_M = new Set(['disability_pct']);
function chahiye(slot) {
  return GAP_SLOT_GENDER_M.has(slot) ? 'होना चाहिए' : 'होनी चाहिए';
}

// A gap is "numeric" for near-miss ranking purposes when both the
// threshold and the citizen's value resolve to comparable numbers —
// excludes date slots (birth_date) and enum slots (category,
// child_status, ...), which have no meaningful "how close" distance.
// Positive = how far short/over the citizen's value is from qualifying.
// A range actual (D2 — e.g. an age band) uses whichever edge is nearer to
// qualifying, since that's the true distance for a range that's already
// been confirmed to fail entirely.
export function gapDistance(gap) {
  const { op, required, actual } = gap;
  const edge = (value, which) => {
    if (typeof value === 'number') return value;
    if (value && typeof value === 'object' && ('min' in value || 'max' in value)) {
      const bound = which === 'min' ? value.min : value.max;
      return typeof bound === 'number' ? bound : null;
    }
    return null;
  };

  if (op === 'gte' && typeof required === 'number') {
    const p = edge(actual, 'max');
    return typeof p === 'number' ? required - p : null;
  }
  if (op === 'lte' && typeof required === 'number') {
    const p = edge(actual, 'min');
    return typeof p === 'number' ? p - required : null;
  }
  if (op === 'between') {
    const { min: lo, max: hi } = parseBounds(required);
    if (lo === -Infinity && hi === Infinity) return null;
    const pMax = edge(actual, 'max');
    const pMin = edge(actual, 'min');
    if (typeof pMax === 'number' && pMax < lo) return lo - pMax;
    if (typeof pMin === 'number' && pMin > hi) return pMin - hi;
    return null;
  }
  return null;
}

export function isNumericGap(gap) {
  return gapDistance(gap) !== null;
}

// "Exactly one gap" can't be read off evaluation.gaps.length directly: an
// any_of with branches gated by a different value of the same categorical
// slot (e.g. a female age threshold and a separate male age threshold)
// produces extra false leaves from the branch that was never relevant to
// this citizen in the first place (RJ_RAJSSP_OLD_AGE's male branch, for a
// citizen who already told us she's female). Counting raw leaves would
// wrongly disqualify her from near-miss over noise from a branch she was
// never on. Instead, test directly: does patching in exactly one numeric
// gap's required value flip the verdict to ELIGIBLE? That's what "one gap
// away" actually means, and it's immune to branches that were never live.
export function findNearMissGap(slots, scheme, evaluation) {
  const numericGaps = evaluation.gaps.filter(isNumericGap);

  // Multiple gaps can share a slot (e.g. two any_of branches each naming
  // their own age threshold, one per gender) — keep only the closest one
  // per slot. Otherwise a scheme with one real shortfall gets treated as
  // two, purely because a second, looser threshold on the same slot also
  // happens to be satisfied once the closer one is.
  const closestPerSlot = new Map();
  numericGaps.forEach((gap) => {
    const existing = closestPerSlot.get(gap.slot);
    if (!existing || gapDistance(gap) < gapDistance(existing)) closestPerSlot.set(gap.slot, gap);
  });

  const fixes = [...closestPerSlot.values()].filter((gap) => {
    const patched = { ...(slots || {}), [gap.slot]: gap.required };
    return evaluate(patched, scheme).verdict === 'ELIGIBLE';
  });
  return fixes.length === 1 ? fixes[0] : null;
}

// Returns a short Hindi sentence naming the specific shortfall for one gap
// (from evaluate()'s gaps array — see js/eligibility.js). Every digit in
// the result must be traceable to either scheme.eligibility (the
// threshold) or this gap's own `actual` (the citizen's own already-stated
// answer, echoed back — not a new claim) — assertNoUnsourcedNumber runs
// before returning, exactly as it does in assemble().
export function explainGap(gap, scheme) {
  const { slot, op, required, actual, kind } = gap;
  const label = labelFor(slot);
  const actualDisplay = formatGapValue(actual);

  let sentence;
  if (kind === 'exclusion') {
    sentence = `${label} के लिए ${formatGapValue(required)} होने के कारण आप इस योजना के लिए अपात्र हैं।`;
  } else if (op === 'gte' && slot === 'age' && typeof required === 'number') {
    // The one case D6 calls out by name: a shortfall the citizen will
    // simply age into, phrased as when they become eligible rather than
    // as a bare failed comparison.
    sentence = `आप ${actualDisplay} के हैं — ${required} की उम्र पर आप पात्र हो जाएंगे।`;
  } else if (op === 'lte' && slot === 'annual_income' && typeof required === 'number') {
    sentence = `आय ₹${required} से कम होनी चाहिए — आपकी ₹${actualDisplay} बताई गई है।`;
  } else if (op === 'gte' && typeof required === 'number') {
    sentence = `${label} कम से कम ${required} ${chahiye(slot)} — आपने बताया: ${actualDisplay}।`;
  } else if (op === 'lte' && typeof required === 'number') {
    sentence = `${label} ${required} से कम ${chahiye(slot)} — आपने बताया: ${actualDisplay}।`;
  } else if (op === 'between') {
    const { min: bLo, max: bHi } = parseBounds(required);
    sentence = `${label} ${bLo} से ${bHi} के बीच ${chahiye(slot)} — आपने बताया: ${actualDisplay}।`;
  } else if (op === 'in') {
    const list = Array.isArray(required) ? required.join(' / ') : String(required);
    sentence = `${label} के लिए इनमें से एक चाहिए: ${list} — आपने बताया: ${actualDisplay}।`;
  } else if (op === 'eq') {
    sentence = `${label} के लिए चाहिए: ${formatGapValue(required)} — आपने बताया: ${actualDisplay}।`;
  } else {
    sentence = `${label} की शर्त पूरी नहीं होती।`;
  }

  assertNoUnsourcedNumber({ text_hi: sentence, speech_hi: sentence }, scheme, [actualDisplay]);
  return sentence;
}
