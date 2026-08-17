// P4: shared by tools/build-registry.mjs (build-time gate) and
// tests/eligibility.test.html (unit assertion) so both run the exact same
// check, not two regexes that could quietly drift apart.
//
// A scheme whose Hindi benefit text states a rupee figure but whose
// amount_inr is null must explain why via rate_policy — otherwise a future
// editor could mistake the null for "not yet researched" and backfill a
// wrong scalar.

// A rupee figure is "₹" or "रु" followed, within up to 15 intervening
// non-digit characters on the same line (e.g. "रु॰ लगभग 500", "रु. करीब
// 1000"), by a Latin or Devanagari digit. Digits are excluded from the
// gap itself so the match anchors on the first digit run after "रु"
// rather than skipping past an unrelated number first.
export const RUPEE_FIGURE_RE = /[₹]|रु[^\n0-9०-९]{0,15}[0-9०-९]/;

export function findAmountPolicyViolations(schemes) {
  const violations = [];
  for (const scheme of schemes) {
    const benefit = scheme.benefit || {};
    const text = benefit.amount_text_hi || '';
    if (benefit.amount_inr === null && RUPEE_FIGURE_RE.test(text) && !benefit.rate_policy) {
      violations.push(scheme.scheme_id);
    }
  }
  return violations;
}
