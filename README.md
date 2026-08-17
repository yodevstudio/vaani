# VAANI — Vernacular Assistance & Navigation for Inclusion

**A voice-first government-scheme discovery assistant for Rajasthan.** Submitted to the Rajasthan Innovation Challenge by YoDevStudio.

> Rajasthan does not have an information problem. Jan Soochna already publishes everything. Rajasthan has a **translation** problem — from ~348 schemes in bureaucratic Hindi into one sentence, in the citizen's own dialect, that they can act on. VAANI is that translation layer. It never invents. It cites, or it refuses.

A citizen speaks a question in Hindi or a Rajasthani dialect (Marwari, Mewari, Dhundhari). VAANI answers aloud, shows required documents as pictures, and points them to the nearest e-Mitra — or tells them honestly that it doesn't know.

**⚠️ Disclosure:** this is a challenge submission prototype, not a deployed government service. No real citizen data is processed anywhere in this repository — every identity flow (Jan Aadhaar) is a client-side simulator, clearly and permanently labelled as such.

---

## The four design principles

1. **The model routes. The state's data answers.** In production an LLM classifies intent and extracts slots — it never authors a factual claim about a scheme. Benefit amounts, eligibility ceilings, and document lists reach the citizen only by substituting into pre-approved templates from a versioned dataset. This prototype's router (`js/router.js`) is deterministic keyword/slot matching, standing in for that LLM without ever risking a fabricated fact.
2. **Consent is a feature, not friction.** Jan Aadhaar data is fetched only through the published OTP flow. The consent screen stays in the demo — see `js/janaadhaar-sim.js`.
3. **Refusing is a correct answer.** Below the router's confidence threshold, VAANI does not guess — it asks a clarifying question with tappable options, or admits it doesn't know and points to e-Mitra.
4. **Never make a promise.** Output is always *"you appear eligible — verify at e-Mitra"* + citation + last-verified date. Never *"you will get ₹X."*

---

## Architecture

```
                          ┌───────────── CITIZEN ─────────────┐
                          │  voice, dialect, low literacy      │
                          └───────────────┬───────────────────┘
                                          │
    ┌────────────────┬────────────────┬───┴────────────┬────────────────┐
    │  Mobile web    │  e-Mitra       │  WhatsApp      │  Telephony     │
    │  (voice-first) │  operator      │  voice note    │  IVR / SIP     │
    │   ✅ LIVE      │  console ✅LIVE │  ▢ Phase 2     │  ▢ Phase 3     │
    └────────────────┴────────────────┴────────────────┴────────────────┘
                                          │
              ═══════════════ CHANNEL ADAPTER (uniform turn object) ═══════
                                          │
    ┌─────────────────────────────────────▼──────────────────────────────┐
    │ 1. SPEECH IN — pluggable ASR adapter (js/speech.js)                 │
    │    Web Speech API, hi-IN (default) │ Bhashini/IndicConformer (prod) │
    │    → Rajasthani lexical normaliser (js/normalise.js)                │
    │    → confidence score attached to every transcript                  │
    └─────────────────────────────────────┬──────────────────────────────┘
                                          │
    ┌─────────────────────────────────────▼──────────────────────────────┐
    │ 2. ROUTER (js/router.js) — deterministic in this prototype          │
    │    in : normalised transcript + schemes                             │
    │    out: { intent, scheme_ids[], slots{}, confidence }               │
    │    PRODUCTION NOTE in the file: an LLM router (schema-validated     │
    │    JSON, no prose, no ₹ figures) replaces this module in prod;      │
    │    this deterministic path is the demo path AND the model's        │
    │    fallback when it's unavailable.                                 │
    │    conf < 0.55 → clarification turn, never a guess                  │
    └─────────────────────────────────────┬──────────────────────────────┘
                                          │
    ┌─────────────────────────────────────▼──────────────────────────────┐
    │ 3. ELIGIBILITY ENGINE (js/eligibility.js) — deterministic, no LLM   │
    │    pure function: (citizen_slots, scheme_record) → verdict         │
    │    verdict ∈ ELIGIBLE | NOT_ELIGIBLE | NEED_MORE_INFO              │
    │    + reasons[] + missing_slots[] — unit-tested, see tests/         │
    └───────────────┬─────────────────────────────────┬──────────────────┘
                    │                                  │
    ┌───────────────▼──────────────┐   ┌──────────────▼──────────────────┐
    │ SCHEME KNOWLEDGE BASE        │   │ IDENTITY — Jan Aadhaar client   │
    │ data/schemes.json, human-     │   │ per Integration Doc v1.8        │
    │ signed. Every record: real   │   │ member-list→generate-otp→       │
    │ source_url + last_verified   │   │ validate-otp, real WebCrypto    │
    │ + templates                  │   │ RSA+AES envelopes               │
    │ source: Jan Soochna / dept.  │   │ ⚠ SIMULATOR — no appCode issued │
    └───────────────┬──────────────┘   └──────────────┬──────────────────┘
                    │                                  │
    ┌───────────────▼──────────────────────────────────▼──────────────────┐
    │ 4. RESPONSE ASSEMBLER (js/assemble.js) — template substitution,     │
    │    not generation. Picks an approved sentence template, fills      │
    │    ₹/date/doc slots. Guards against ever speaking an unsourced     │
    │    number — see "Anti-hallucination guarantee" below.              │
    └─────────────────────────────────────┬──────────────────────────────┘
                                          │
    ┌─────────────────────────────────────▼──────────────────────────────┐
    │ 5. SPEECH OUT (js/speech.js) — TTS adapter                          │
    │    Web Speech Synthesis (hi-IN) + on-screen document illustration   │
    │    cards (assets/docs/*.svg), always audio-paired                   │
    └─────────────────────────────────────────────────────────────────────┘
```

Orchestration (`js/app.js`) wires steps 1–5 together for the citizen surface, plus the offline cache and the citizen/e-Mitra mode toggle. `js/operator.js` is the same engine on a denser, keyboard-first surface for a queue-facing e-Mitra operator.

---

## What's live vs simulated

Also viewable inside the app itself: click **"क्या असली, क्या सिम्युलेटेड?"** in the footer — those counts are pulled live from the loaded JSON so this table and the app can't drift apart.

| | Status |
|---|---|
| Microphone speech recognition (Web Speech API, hi-IN) | ✅ Live |
| Rajasthani lexical normalisation (117 entries, `data/lexicon.json`) | ✅ Live |
| Deterministic eligibility engine (34 schemes, all rules unit-tested) | ✅ Live |
| Discovery flow ("मुझे क्या-क्या मिल सकता है?" — six-question core sequence, ranked eligible/needs-info/not-eligible groups, driven by `data/slots.json`) | ✅ Live |
| Near-miss explanations (`explainGap` — schemes one numeric shortfall from eligible, phrased as a short Hindi sentence) | ✅ Live |
| Slot question catalogue (`data/slots.json`, 55 slots) | ✅ Live |
| Scheme registry API (`api/v1/` — versioned, static, one file per scheme) | ✅ Live |
| Embeddable widget (`embed/vaani-embed.js` — one `<script>` tag, shadow-DOM isolated, reads `api/v1/`) | ✅ Live |
| Spoken responses (Web Speech Synthesis) | ✅ Live |
| Document illustration checklists | ✅ Live |
| Installable, and fully offline after first load (`manifest.webmanifest` + `sw.js`) | ✅ Live |
| e-Mitra operator mode (editable slots, print checklist) | ✅ Live |
| Jan Aadhaar API (spec-exact per Integration Doc v1.8) | 🧪 Simulated — see below |
| WhatsApp share (every verdict card + the discovery result, via `wa.me`) | ✅ Live |
| WhatsApp conversational bot | ▢ Phase 2 |
| Telephony / IVR | ▢ Phase 3 |
| Dialect **acoustic** ASR (accent/pronunciation modelling) | ▢ Not attempted — see limits below |

**On the embed widget:** `embed/vaani-embed.js` turns the registry from "a JSON file the main app happens to read" into infrastructure a second consumer can actually use. Any page adds one line — `<script src=".../embed/vaani-embed.js" data-scheme="RJ_PALANHAR"></script>` — and gets a compact eligibility checker for that one scheme: name, a question flow scoped to only that scheme's own slots, a verdict, its document list, and its citation. It fetches `api/v1/schemes/{id}.json` and dynamically imports `js/eligibility.js` and `js/assemble.js` from this same deployment — not a reimplementation, the exact same verdict code and response wording the main app uses, so it cannot disagree with it. It renders inside a shadow root, so a host page's CSS can never reach in and the widget's CSS can never leak out — verified directly: the widget keeps its own fonts and colours even embedded in a host page using a completely different font stack. Any failure (bad scheme id, network error, a failed import) degrades to a plain link to the main app rather than an error or a blank box. See [`demo/department-page.html`](demo/department-page.html) — a page clearly labelled as a fictional mock, embedding the widget via exactly that one line, proving the integration doesn't require opening the main app at all.

**On offline support:** the app is installable to a home screen (`manifest.webmanifest` — standalone display, `#1B3A6B` theme colour, maskable icon) and runs fully offline after the first load. `sw.js` precaches `index.html`, the CSS, every `js/*.js` module, `data/*.json`, both self-hosted fonts, and every document illustration SVG, then serves cache-first with a network fallback — an installed citizen doesn't need a connection to complete a discovery flow. The cache is versioned and old versions are cleared on activate. The service worker registers only over genuine HTTPS (`location.protocol === 'https:'`, no localhost exception carved out), so this repo's local dev flow (`python -m http.server`, plain HTTP) is never affected by a stale cached worker. This is layered on top of, not a replacement for, the existing `localStorage` caching of the lexicon/scheme/slot JSON payloads — that still avoids a needless re-fetch on a warm reload even when the service worker itself is inactive (e.g. local testing).

**On WhatsApp:** sharing works today — a "व्हाट्सएप पर भेजें" button on every verdict card and on the discovery result opens `https://wa.me/?text=` with a plain-text summary (scheme name, document checklist, citation URL, last-verified date) pre-filled, no API key or backend involved. This is how information actually travels in rural Rajasthan: one literate family member forwards it to others who aren't online or can't read it themselves. The conversational WhatsApp *bot* — answering questions inside a WhatsApp chat — remains Phase 2 and requires Meta Business API verification, which is a real onboarding process, not a code change.

**On the router:** this prototype's `js/router.js` is deterministic keyword/slot matching, not an LLM — a deliberate choice, not a shortcut. Every eligibility decision in this demo is reproducible and auditable. In production the model does routing only, and if it were unavailable, this exact deterministic behaviour is the fallback.

**On dialect support:** `data/lexicon.json` is a **lexical** layer — it corrects vocabulary (117 hand-verified Marwari/Mewari/Dhundhari → standard Hindi mappings), not pronunciation. It does not claim to solve **acoustic** dialect recognition, which needs labelled Rajasthani speech data that a real pilot would generate.

---

## Anti-hallucination guarantee

This is the single most important property of the system: **the app is physically unable to speak a rupee figure, eligibility ceiling, or date that isn't traceable to `data/schemes.json`.**

- `js/assemble.js` builds every citizen-facing sentence **only** by substituting `{{placeholders}}` into a scheme's pre-approved `response_templates_hi` — it never composes prose.
- If a scheme's `amount_inr` is `null` (28 of the 34 schemes in the current dataset — a benefit that's staged, revised periodically, or varies by category is deliberately left as descriptive text rather than a single misleading scalar; see `VERIFICATION.md`), the assembler falls back to the human-written `amount_text_hi` description instead of inventing a number. The other 6 state one stable, dated cash figure directly (e.g. PM-KISAN's ₹6,000/year), which `assemble.js` renders as `₹{amount_inr}`.
- If a scheme has no `source_url`, the assembler refuses to answer at all and returns the `unknown` template, regardless of verdict.
- `assertNoUnsourcedNumber(output, scheme)` — exported from `js/assemble.js` — throws if the assembled text contains any digit sequence (Devanagari `०-९` or Latin) that isn't present in a deliberately narrow allowlist: `benefit.amount_inr`, `benefit.amount_text_hi`, `name_hi`, and a serialisation of `scheme.eligibility` (needed so `explainGap`'s near-miss sentences can name a threshold figure — see below). Fields like `dataset_version` or `last_verified` are excluded on purpose, so a version stamp or a date can never launder an unrelated figure into speech. It runs on every non-`unknown` response before that response is returned.
- `explainGap(gap, scheme)` turns one structured gap from `evaluate()`'s `gaps` array into a short Hindi sentence — e.g. naming an income shortfall, or phrasing an age gap as "you'll become eligible at 55" — and runs the same guard on its own output before returning. The discovery flow's near-miss section (schemes one numeric gap from `ELIGIBLE`, found by `findNearMissGap` actually patching in the fix and re-evaluating, not by counting raw gap leaves) is built on this.

**Verify it yourself:** open [`tests/eligibility.test.html`](tests/eligibility.test.html) in a browser — assertions run client-side against the real scheme data (no test framework), covering every verdict path, every eligibility operator, the structured `gaps` output, the anti-hallucination guard (including its `scheme.eligibility` allowlist), and `explainGap`'s near-miss sentences.

---

## Data provenance

Every record in [`data/schemes.json`](data/schemes.json) carries:
- `source_url` — the Jan Soochna page or department portal it was verified against.
- `last_verified` — the date a human confirmed the record against that source.
- `dataset_version` — so any past answer can be reproduced and attributed to a specific signed-off revision.

34 schemes are currently verified and shipped — each one traceable to the table below, and machine-readable at [`api/v1/index.json`](api/v1/index.json). **A verified 34 beats an unverified pile of guesses** — the dataset grows only as fast as verification does, on purpose.

<details>
<summary>All 34 verified schemes (Hindi / English)</summary>

| Hindi | English |
|---|---|
| इंदिरा गांधी मातृत्व पोषण योजना | Indira Gandhi Matritva Poshan Yojana |
| इंदिरा गांधी शहरी रोजगार गारंटी योजना | Indira Gandhi Shahri (Urban) Rozgar Guarantee Yojana |
| उत्तर मैट्रिक (पोस्ट मैट्रिक) छात्रवृत्ति योजना | Post-Matric Scholarship Scheme (SC / ST / OBC / Minority) |
| काली बाई भील मेधावी छात्रा स्कूटी योजना | Kali Bai Bheel Medhavi Chhatra Scooty Yojana |
| किसान क्रेडिट कार्ड योजना | Kisan Credit Card (KCC) Scheme |
| खेत तलाई अनुदान योजना | Farm Pond (Khet Talai) Subsidy Scheme |
| गार्गी पुरस्कार एवं बालिका प्रोत्साहन पुरस्कार योजना | Gargi Puraskar & Balika Protsahan Puraskar Yojana |
| देवनारायण छात्रा स्कूटी वितरण एवं प्रोत्साहन राशि योजना | Devnarayan Chhatra Scooty Vitran evam Protsahan Rashi Yojana |
| पालनहार योजना | Palanhar Yojana |
| प्रधानमंत्री आवास योजना - ग्रामीण | Pradhan Mantri Awas Yojana - Gramin (PMAY-G) |
| प्रधानमंत्री आवास योजना - शहरी 2.0 | Pradhan Mantri Awas Yojana - Urban 2.0 (PMAY-U 2.0) |
| प्रधानमंत्री उज्ज्वला योजना 2.0 | Pradhan Mantri Ujjwala Yojana 2.0 (PMUY) |
| प्रधानमंत्री किसान सम्मान निधि योजना | PM Kisan Samman Nidhi Yojana |
| प्रधानमंत्री फसल बीमा योजना | Pradhan Mantri Fasal Bima Yojana (PMFBY) |
| भवन एवं अन्य सन्निर्माण कर्मकार कल्याण मंडल - कल्याण योजनाएं | Rajasthan BOCW Welfare Board - Welfare Schemes |
| मुख्यमंत्री अनुप्रति कोचिंग योजना | Mukhyamantri Anuprati Coaching Yojana |
| मुख्यमंत्री आयुष्मान आरोग्य योजना | Mukhyamantri Ayushman Arogya Yojana |
| मुख्यमंत्री एकल नारी सम्मान पेंशन योजना | Mukhyamantri Ekal Nari Samman Pension Yojana |
| मुख्यमंत्री चिरंजीवी श्रमिक संबल योजना | Mukhyamantri Chiranjeevi Shramik Sambal Yojana |
| मुख्यमंत्री निःशुल्क दवा एवं जांच योजना | Mukhyamantri Nishulk Dawa evam Janch Yojana |
| मुख्यमंत्री युवा संबल योजना (बेरोजगारी भत्ता) | Mukhyamantri Yuva Sambal Yojana |
| मुख्यमंत्री राजश्री योजना | Mukhyamantri Rajshree Yojana |
| मुख्यमंत्री विशेष योग्यजन सम्मान पेंशन योजना | Mukhyamantri Vishesh Yogyajan Samman Pension Yojana |
| मुख्यमंत्री वृद्धजन सम्मान पेंशन योजना | Mukhyamantri Vridhjan Samman Pension Yojana |
| राजस्थान तारबंदी योजना | Rajasthan Tarbandi Yojana |
| राजस्थान सरकारी स्वास्थ्य योजना (आरजीएचएस) | Rajasthan Government Health Scheme (RGHS) |
| राजस्थान सिलिकोसिस नीति - पीड़ित सहायता योजना | Rajasthan Silicosis Policy - Victim Assistance Scheme |
| राष्ट्रीय खाद्य सुरक्षा अधिनियम (राशन/खाद्य सुरक्षा योजना) | National Food Security Act (NFSA) |
| विकसित भारत - ग्राम रोजगार एवं आजीविका मिशन (ग्रामीण) अधिनियम, 2025 (पूर्व में मनरेगा) | Viksit Bharat Gram Rozgar Guarantee Act, 2025 (successor to MGNREGA) |
| विधवा विवाह उपहार योजना | Scheme of Gift on Widow's Marriage |
| विशेष योग्यजन सहायक उपकरण योजना (ADIP) | Assistance to Disabled Persons for Aids & Appliances (ADIP) |
| वृद्धजन कृषक सम्मान पेंशन योजना | Vridhjan Krishak Samman Pension Yojana |
| शुभ शक्ति योजना | Shubh Shakti Yojana |
| सूक्ष्म सिंचाई (ड्रिप/स्प्रिंकलर) अनुदान योजना | Micro-Irrigation (Drip/Sprinkler) Subsidy Scheme |

</details>

---

## Jan Aadhaar integration — what's real, what's next

`js/janaadhaar-sim.js` implements the three documented endpoints (`memberList`, `generateOtp`, `validateOtp`) exactly per **Jan Aadhaar Integration Document v1.8**, including genuine WebCrypto AES-256-CBC + RSA-OAEP envelope construction (throwaway keypairs, generated fresh in-browser, never persisted) and all 8 documented `JAN_*` response codes. It carries a permanent, non-dismissible banner disclosing that it's simulated.

**What deploying the real integration requires (DoIT&C-side, not ours to solve):**
- Digital signature of the nodal authority
- An encryption certificate (public/private pair, public key shared with Jan Aadhaar)
- Server IP whitelisting
- An approved onboarding request returning `appCode`, `schemeCode`, and Jan Aadhaar's public key
- A Raj Sewa Dwaar `client_id` via subscription

Contact for onboarding: **apim.rsd@rajasthan.gov.in**

---

## What VAANI deliberately does not do

- ✗ Submit applications on a citizen's behalf — it prepares them for e-Mitra.
- ✗ Store Aadhaar or Jan Aadhaar numbers, ever — `localStorage` holds only the lexicon, scheme dataset, and UI preferences.
- ✗ Promise money — it reports apparent eligibility with a source and a date.
- ✗ Claim dialect **acoustic** ASR that doesn't exist — it normalises vocabulary and gates on confidence.
- ✗ Replace e-Mitra operators — it removes their unpaid informational work.
- ✗ Free-generate scheme facts, ever. There is no code path for it.

---

## Repository layout

```
vaani/
├── index.html              citizen + operator + Jan Aadhaar + disclosure UI shell
├── css/vaani.css            all styling, self-hosted fonts, print stylesheet
├── js/
│   ├── app.js               orchestration, state machine, mode toggle, discovery flow
│   ├── speech.js             ASR + TTS adapter (Web Speech API)
│   ├── normalise.js          Rajasthani lexical normalisation
│   ├── router.js             deterministic intent + slot extraction
│   ├── eligibility.js        pure rules engine
│   ├── assemble.js           template substitution + anti-hallucination guard + near-miss explanations
│   ├── amount-policy.js      shared amount_inr/rate_policy check (build script + test suite)
│   ├── janaadhaar-sim.js     Jan Aadhaar v1.8 simulator (real WebCrypto)
│   ├── operator.js           e-Mitra operator mode
│   └── pwa.js                service worker registration (HTTPS-only)
├── data/
│   ├── schemes.json          34 verified schemes, sourced + dated
│   ├── slots.json            55-slot discovery question catalogue
│   ├── lexicon.json          117 dialect→standard-Hindi mappings
│   └── samples.json          fallback sample-query chips
├── assets/
│   ├── docs/*.svg             18 schematic document illustrations (no real emblems), incl. a generic fallback
│   ├── icons/icon.svg          maskable app icon (192/512, see manifest.webmanifest)
│   └── fonts/                 self-hosted Noto Sans Devanagari + Inter (OFL)
├── manifest.webmanifest     PWA manifest — installable, standalone display
├── sw.js                    service worker — offline precache, cache-first
├── api/v1/                  versioned static registry API — see "Publishing the scheme registry API" below
├── embed/vaani-embed.js     embeddable eligibility-checker widget — a second registry consumer
├── demo/department-page.html   mock (clearly labelled) host page embedding the widget in one line
├── docs/data-provenance/    audit trail from the 26-scheme data merge (not shipped to the citizen UI)
├── tools/build-registry.mjs  validates + publishes data/schemes.json as api/v1/
├── tests/eligibility.test.html   64 client-side assertions across 4 sections, plus a 34-scheme amount-policy gate — no framework
├── LICENSE, SECURITY.md, VERIFICATION.md
├── .gitattributes           pins *.json/*.mjs/*.js to LF line endings
└── README.md
```

---

## Running it locally

No build step, no dependencies, no server framework — just a static file server so ES modules and `fetch()` work:

```bash
python3 -m http.server 8000
# or on Windows: python -m http.server 8000
```

Then open `http://localhost:8000/index.html` in Chrome (Web Speech API support required for live mic input; the app falls back to tappable sample chips and typed input otherwise — it never dead-ends).

---

## Publishing the scheme registry API

`tools/build-registry.mjs` runs two build-time gates, then publishes `data/schemes.json` as a static, versioned API under `api/v1/`:
- fails if any `benefit.amount_inr` is `null` while `amount_text_hi` states a rupee figure with no `rate_policy` explaining why (see `js/amount-policy.js`);
- fails if any scheme-count figure stated in this README disagrees with `data/schemes.json`'s actual length — the exact drift that made this section wrong three times before the check existed.

```bash
node tools/build-registry.mjs
```

- `api/v1/schemes.json` — the full registry, wrapped in `{ version, generated_at, count, schemes }`.
- `api/v1/schemes/{scheme_id}.json` — one static file per scheme (34 files).
- `api/v1/index.json` — a lightweight catalogue: `{ scheme_id, name_hi, name_en, department, last_verified }` per scheme.
- `api/v1/versions.json` — append-only publish history (`{ version, date, count, changelog }`); a new entry is added only when the registry's version (the newest `dataset_version` among its schemes) or its scheme count changes, so re-running the script after an unrelated code change doesn't spam the history.

Plain Node, no dependencies — run it any time `data/schemes.json` changes, before committing.

---

## Licence

This repository is a submission to the Rajasthan Innovation Challenge; intellectual property terms follow the challenge's IIC guidelines. The bundled fonts (`assets/fonts/`) are Noto Sans Devanagari and Inter, both under the SIL Open Font License — see `OFL-*.txt` alongside them. The Rajasthani lexicon (`data/lexicon.json`) is intended as an open contribution to DoIT&C, per the note in that file.
