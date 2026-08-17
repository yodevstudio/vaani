# Data verification

How `data/schemes.json` stays accurate, and what happens when it doesn't.

## The cadence

Every scheme record carries three fields that exist for this purpose:

- `last_verified` — the date a human last checked the record against `source_url` (and, where present, `source_url_secondary`).
- `verification_interval_days` — currently `90` for every record. Ninety days balances two failure modes: check too rarely and a revised rate goes stale in production; check too often and re-verification work crowds out everything else a one-person team has to do.
- `next_review_due` — `last_verified + verification_interval_days`, computed at the time of verification, not derived at read time. It's a plain field so the UI can flag it without recomputing anything.

The UI surfaces this directly rather than hiding it: every citation shows `last_verified` as a relative age ("14 दिन पहले जाँचा गया"), and once today passes `next_review_due` an amber "⚠ समीक्षा अपेक्षित" (review due) badge appears next to that scheme's citation — in the citizen verdict card, in discovery results, and in the operator table. See `isPastReviewDue()` / `formatRelativeVerifiedAge()` in `js/app.js`.

**The badge is not a claim that the figure is wrong.** It's a claim that the check is late. Those are different failure modes and the UI is deliberately worded not to conflate them — a citizen should not read "review due" as "this pension amount changed."

## Who owns re-verification

Today: one person (YoDevStudio), manually, against the `source_url` listed on each record. In a funded pilot, this is the first thing that should move to the department side — a dataset a vendor alone keeps current is a vendor lock-in risk, not an asset. `REGISTRY.md` (planned, not yet built) is where the handover mechanics would live: who can approve a revision, what the sign-off record looks like, how a department reviewer flags a record without a code change.

Until then: re-verification means opening `source_url`, confirming the eligibility conditions and any stated figures still match, and updating `last_verified` + `dataset_version` in the same commit. If a source page has moved or a figure has changed, that's a data commit on its own — not bundled with an unrelated code change — so the diff stays reviewable.

## What happens when a source page changes

- **URL still resolves, content matches**: bump `last_verified` and `next_review_due`, no other change.
- **URL still resolves, a condition or figure changed**: update the record, bump `dataset_version`, and if the change affects a number already covered by `assertNoUnsourcedNumber`'s allowlist (`js/assemble.js`), no code change is needed — the guard reads `scheme.eligibility` and `benefit` at runtime, not a hardcoded copy.
- **URL moved or 404s**: do not guess the replacement. Set `source_url` to the new page only once confirmed live and topically correct (the July 2026 audit caught three records pointing at the wrong page this way — a plausible-looking URL is not a verified one). Until confirmed, prefer `source_url_secondary` (typically `jansoochna.rajasthan.gov.in`, the state's own scheme index) as the primary citation and leave a note.
- **A rate figure becomes genuinely stable and singular** (not the case for any record today — see below): only then does `benefit.amount_inr` get a numeric value instead of `null`. Setting it is a decision that a single figure is safe to speak verbatim; see the next section for why that bar hasn't been met yet.

## Why every `amount_inr` is still `null`

This was checked directly during the 2026-08-14 pass, scheme by scheme — not assumed. Every one of the 8 records has a structural reason a single number would misrepresent the benefit, not just a "rates change" caveat:

| Scheme | Why `amount_inr` stays `null` |
|---|---|
| Old-age / widow / disability pension, Palanhar | Rate has been revised multiple times across recent years (`rate_policy: REVISED_PERIODICALLY_DO_NOT_STATE`) |
| Rajshree | ₹50,000 total is real, but paid across 6 installments of different sizes — a bare `₹50000` would misrepresent it as a lump sum (`STAGED_DISBURSEMENT_DO_NOT_COLLAPSE`) |
| Tarbandi | Subsidy is 50–70% / ₹40,000–56,000 depending on individual vs. group application (`VARIES_BY_CATEGORY_DO_NOT_COLLAPSE`) |
| Berojgari Bhatta | ₹4,000/month vs ₹4,500/month depending on gender/category — `amount_inr` can only hold one number, and holding the wrong one for half the applicant pool is worse than holding none | 
| Ayushman | ₹25 lakh health cover + ₹10 lakh accident cover + a conditional ₹850 premium are three figures, not one (`MULTIPLE_FIGURES_DO_NOT_COLLAPSE`) |

This is a property of `js/assemble.js`'s current design, not a data gap: `getBenefitText()` treats `amount_inr` as fully replacing `amount_text_hi` when set, so a scalar `amount_inr` can only ever be correct for benefits that really do reduce to one number for everyone. None of today's 8 do. If a future scheme's benefit genuinely is one number for everyone, that's when `amount_inr` should first be populated — not before.
