import { normalise, loadLexicon } from './normalise.js';
import { route, CONFIDENCE_THRESHOLD, RAJASTHAN_DISTRICTS } from './router.js';
import { evaluate, evaluateAll } from './eligibility.js';
import { assemble, explainGap, findNearMissGap, gapDistance } from './assemble.js';
import { listen, stopListening, speak, isRecognitionSupported, initTts, getTtsVoiceInfo, cancelSpeech } from './speech.js';
import { initOperator, activateOperatorView, deactivateOperatorView, refreshOperatorAfterTurn } from './operator.js';
import { initJanAadhaar } from './janaadhaar-sim.js';
import { registerServiceWorker } from './pwa.js';

const SCHEMES_STORAGE_KEY = 'vaani.schemes.v1';
const LEXICON_STORAGE_KEY = 'vaani.lexicon.v1';
const SLOTS_STORAGE_KEY = 'vaani.slots.v1';

const CLARIFICATION_PROMPT_HI = 'मुझे ठीक से समझ नहीं आया। क्या आप इनमें से कोई पूछ रहे हैं?';
const NO_MATCH_MESSAGE_HI = 'समझ नहीं आया — नीचे से कोई सवाल चुनें या टाइप करें';
const LOAD_ERROR_HI = 'डेटा लोड नहीं हो सका — कृपया इंटरनेट जांचें और पुनः प्रयास करें';
const DEFAULT_FALLBACK_MESSAGE_HI = 'माइक दबाकर बोलिए, नीचे से कोई सवाल चुनें, या टाइप करें';

// S3: below CONFIDENCE_THRESHOLD but not hopeless — confirm what was heard
// before jumping to the generic clarification chips. Below this floor the
// transcript is too unreliable to even read back.
const CONFIRM_HEARD_MIN_CONFIDENCE = 0.3;

const VERDICT_ICONS = { ELIGIBLE: '✓', NOT_ELIGIBLE: '✕' };
const VERDICT_CARD_CLASS = { ELIGIBLE: 'verdict-card--eligible', NOT_ELIGIBLE: 'verdict-card--not-eligible' };
const VERDICT_BADGE_HI = { ELIGIBLE: 'आप पात्र लग रहे हैं', NOT_ELIGIBLE: 'आप शायद पात्र नहीं हैं' };

// ===== Discovery flow (M1): driven by data/slots.json =====
// Sentinel for "पता नहीं" — distinct from any real option value (including
// legitimate `null`s and `false`s already used by real slots) so it can
// never collide with one. Choosing it leaves the slot unset on purpose:
// never infer a value from silence.
const DONT_KNOW = Symbol('dont-know');
const DONT_KNOW_HI = 'पता नहीं';

// ===== DOM refs =====
const micButton = document.getElementById('mic-button');
const micStatus = document.getElementById('mic-status');
const transcriptLine = document.getElementById('transcript-line');
const normalisationBlock = document.getElementById('normalisation-block');
const normalisationLine = document.getElementById('normalisation-line');
const clarificationChips = document.getElementById('clarification-chips');
const fallbackPanel = document.getElementById('fallback-panel');
const fallbackMessage = document.getElementById('fallback-message');
const fallbackChips = document.getElementById('fallback-chips');
const typedForm = document.getElementById('typed-input-form');
const typedInput = document.getElementById('typed-input');
const verdictCard = document.getElementById('verdict-card');
const verdictIcon = document.getElementById('verdict-icon');
const verdictTitle = document.getElementById('verdict-title');
const verdictSchemeName = document.getElementById('verdict-scheme-name');
const documentCardsEl = document.getElementById('document-cards');
const verdictCitation = document.getElementById('verdict-citation');
const verdictShareBtn = document.getElementById('verdict-share-btn');
const appMain = document.querySelector('.app-main');
const operatorViewEl = document.getElementById('operator-view');
const modeCitizenBtn = document.getElementById('mode-citizen');
const modeEmitraBtn = document.getElementById('mode-emitra');
const discoveryEntryBtn = document.getElementById('discovery-entry-btn');
const discoveryResultsEl = document.getElementById('discovery-results');
const discoveryEligibleHeading = document.getElementById('discovery-eligible-heading');
const discoveryEligibleCards = document.getElementById('discovery-eligible-cards');
const discoveryShareAllBtn = document.getElementById('discovery-share-all-btn');
const discoveryNeedinfoHeading = document.getElementById('discovery-needinfo-heading');
const discoveryNeedinfoList = document.getElementById('discovery-needinfo-list');
const discoveryNearmissGroup = document.getElementById('discovery-nearmiss-group');
const discoveryNearmissHeading = document.getElementById('discovery-nearmiss-heading');
const discoveryNearmissList = document.getElementById('discovery-nearmiss-list');
const discoveryNoteligibleToggle = document.getElementById('discovery-noteligible-toggle');
const discoveryNoteligibleList = document.getElementById('discovery-noteligible-list');

// ===== State =====
let lexicon = null;
let schemes = null;
let slotsCatalogue = null;
let sessionStartTime = null;

// Discovery flow (M1): null when inactive. `stack` holds the indices into
// core_sequence (data/slots.json) actually shown so far (for "back"); the
// last entry is the question currently on screen.
let discoveryFlow = null;

// Conversation is session-persistent: slots the citizen has already given
// stay known across topics (matches the PII/slot design in the spec), but
// schemeId/awaitingSlot track the single in-progress question, if any.
const conversation = { schemeId: null, awaitingSlot: null, slots: {} };

function getSessionElapsedSeconds() {
  return sessionStartTime === null ? null : (Date.now() - sessionStartTime) / 1000;
}

function resetConversation() {
  conversation.schemeId = null;
  conversation.awaitingSlot = null;
  conversation.slots = {};
  discoveryFlow = null;
  renderTranscript('');
  normalisationBlock.hidden = true;
  // Return to the same helpful default the app opens on, not a blank screen.
  showFallback(DEFAULT_FALLBACK_MESSAGE_HI);
}

// ===== Offline-aware data loading =====
async function loadJsonWithCache(url, storageKey) {
  if (!navigator.onLine) {
    const cached = localStorage.getItem(storageKey);
    if (cached) return JSON.parse(cached);
  }
  try {
    const response = await fetch(url);
    const data = await response.json();
    try { localStorage.setItem(storageKey, JSON.stringify(data)); } catch (_) { /* storage full/unavailable: caching is best-effort */ }
    return data;
  } catch (err) {
    const cached = localStorage.getItem(storageKey);
    if (cached) return JSON.parse(cached);
    throw err;
  }
}

function loadSchemesCached() {
  return loadJsonWithCache('data/schemes.json', SCHEMES_STORAGE_KEY);
}

function loadSlotsCached() {
  return loadJsonWithCache('data/slots.json', SLOTS_STORAGE_KEY);
}

async function loadLexiconCached() {
  if (!navigator.onLine) {
    const cached = localStorage.getItem(LEXICON_STORAGE_KEY);
    if (cached) return JSON.parse(cached);
  }
  try {
    return await loadLexicon(); // fetches + caches internally (normalise.js)
  } catch (err) {
    const cached = localStorage.getItem(LEXICON_STORAGE_KEY);
    if (cached) return JSON.parse(cached);
    throw err;
  }
}

// ===== Small pure helpers =====
const DEVANAGARI_DIGITS = '०१२३४५६७८९';

function extractBareNumber(text) {
  const digitText = text.replace(/[०-९]/g, (d) => String(DEVANAGARI_DIGITS.indexOf(d)));
  const match = digitText.match(/\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

// ===== X3: staleness display — a citation's own last_verified/next_review_due =====
function daysBetween(fromDateStr, toDate) {
  const from = new Date(`${fromDateStr}T00:00:00`);
  if (Number.isNaN(from.getTime())) return null;
  return Math.floor((toDate.getTime() - from.getTime()) / 86400000);
}

function formatRelativeVerifiedAge(lastVerified) {
  if (!lastVerified) return null;
  const days = daysBetween(lastVerified, new Date());
  if (days === null || days < 0) return null;
  if (days === 0) return 'आज जाँचा गया';
  if (days === 1) return '1 दिन पहले जाँचा गया';
  return `${days} दिन पहले जाँचा गया`;
}

// True once today is past the record's own next_review_due — a signal that
// the figure hasn't been re-checked on schedule, not that it's wrong.
function isPastReviewDue(nextReviewDue) {
  if (!nextReviewDue) return false;
  const days = daysBetween(nextReviewDue, new Date());
  return days !== null && days > 0;
}

// ===== M1: slots.json-driven questions (discovery flow + per-scheme follow-ups) =====
function findSlotDef(slotName) {
  return slotsCatalogue && slotsCatalogue.slots.find((s) => s.slot === slotName);
}

// Startup guard: if a slot referenced by any scheme's eligibility conditions
// has no data/slots.json entry, the discovery flow can never resolve that
// scheme — warn loudly in the console rather than let it fail silently the
// first time a citizen hits it.
function validateSlotsCoverage() {
  if (!slotsCatalogue || !schemes) return;
  const known = new Set(slotsCatalogue.slots.map((s) => s.slot));
  const used = new Set();
  schemes.forEach((scheme) => {
    const elig = scheme.eligibility || {};
    ['all_of', 'any_of', 'none_of'].forEach((group) => {
      (elig[group] || []).forEach((entry) => {
        (Array.isArray(entry) ? entry : [entry]).forEach((c) => used.add(c.slot));
      });
    });
  });
  const missing = [...used].filter((s) => !known.has(s));
  if (missing.length > 0) {
    console.warn(
      `[VAANI] data/slots.json is missing ${missing.length} slot(s) referenced by data/schemes.json: ${missing.join(', ')} — the discovery flow can never resolve these until they're added.`
    );
  }
}

// A uniform {value, label} list for any slots.json-defined question,
// regardless of type. 'single'/'boolean'/'range_select' all already carry
// their own `options` array — including the "पता नहीं" -> null entry, so
// callers don't add a separate one. 'district_select' has no embedded
// options (see the note in slots.json); built here from the same
// RAJASTHAN_DISTRICTS list router.js uses for extraction, not a second
// copy. 'date' has no discrete options at all (null).
function optionsForSlotDef(def) {
  if (def.options) return def.options.map((o) => ({ value: o.value, label: o.label_hi }));
  if (def.type === 'district_select') {
    return [...RAJASTHAN_DISTRICTS]
      .sort((a, b) => a.localeCompare(b, 'hi'))
      .map((d) => ({ value: d, label: d }))
      .concat([{ value: null, label: DONT_KNOW_HI }]);
  }
  return null;
}

// Renders just the answer widget (buttons, or a date input) for one
// slots.json slot into `container` and calls onAnswer(value) — value is
// the sentinel DONT_KNOW, never a bare null, so every caller has one
// consistent way to check "did they actually answer". No heading is
// rendered here: the core discovery flow wants a big standalone question
// (its own `answer-headline`), a per-scheme follow-up wants to keep using
// assemble()'s natural "I need X" sentence as its intro — two different
// framings around the identical answer widget, so the widget itself stays
// framing-agnostic.
function renderCatalogueOptions(container, slotName, onAnswer) {
  const def = findSlotDef(slotName);
  if (!def) {
    console.warn(`[VAANI] slots.json has no entry for "${slotName}" — cannot render this question.`);
    const notice = document.createElement('p');
    notice.className = 'discovery-noteligible-item__detail';
    notice.textContent = 'जानकारी अधूरी';
    container.appendChild(notice);
    return;
  }

  const optionsWrap = document.createElement('div');
  optionsWrap.className = 'discovery-options';

  if (def.type === 'date') {
    const input = document.createElement('input');
    input.type = 'date';
    input.className = 'discovery-date-input';
    optionsWrap.appendChild(input);

    const submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'chip-btn';
    submitBtn.textContent = 'ठीक है';
    submitBtn.addEventListener('click', () => { if (input.value) onAnswer(input.value); });
    optionsWrap.appendChild(submitBtn);

    const dontKnowBtn = document.createElement('button');
    dontKnowBtn.type = 'button';
    dontKnowBtn.className = 'chip-btn chip-btn--muted';
    dontKnowBtn.textContent = DONT_KNOW_HI;
    dontKnowBtn.addEventListener('click', () => onAnswer(DONT_KNOW));
    optionsWrap.appendChild(dontKnowBtn);
  } else {
    (optionsForSlotDef(def) || []).forEach(({ value, label }) => {
      const isDontKnow = value === null;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = isDontKnow ? 'chip-btn chip-btn--muted' : 'chip-btn';
      btn.textContent = isDontKnow ? DONT_KNOW_HI : label;
      btn.addEventListener('click', () => onAnswer(isDontKnow ? DONT_KNOW : value));
      optionsWrap.appendChild(btn);
    });
  }

  container.appendChild(optionsWrap);
}

// ===== Render: mutually-exclusive result zones =====
function hideAllResultZones() {
  clarificationChips.hidden = true;
  clarificationChips.innerHTML = '';
  fallbackPanel.hidden = true;
  verdictCard.hidden = true;
  discoveryResultsEl.hidden = true;
}

function renderTranscript(text) {
  transcriptLine.textContent = text;
}

function renderNormalisation(normalisedText, substitutions) {
  if (substitutions && substitutions.length > 0) {
    normalisationLine.textContent = normalisedText;
    normalisationBlock.hidden = false;
  } else {
    normalisationBlock.hidden = true;
  }
}

function showFallback(message) {
  hideAllResultZones();
  fallbackMessage.textContent = message;
  fallbackPanel.hidden = false;
}

function renderClarificationSchemes(candidateSchemes) {
  hideAllResultZones();
  clarificationChips.innerHTML = '';

  const heading = document.createElement('p');
  heading.className = 'answer-headline';
  heading.textContent = CLARIFICATION_PROMPT_HI;
  clarificationChips.appendChild(heading);

  candidateSchemes.forEach((scheme) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip-btn';
    btn.textContent = scheme.name_hi;
    btn.addEventListener('click', () => {
      conversation.schemeId = scheme.scheme_id;
      conversation.awaitingSlot = null;
      runEligibilityForFocusedScheme();
    });
    clarificationChips.appendChild(btn);
  });

  clarificationChips.hidden = false;
  speak(CLARIFICATION_PROMPT_HI);
}

function renderSlotQuestion(scheme, slot, spokenText, shouldSpeak) {
  hideAllResultZones();
  clarificationChips.innerHTML = '';

  const heading = document.createElement('p');
  heading.className = 'answer-headline';
  heading.textContent = spokenText;
  clarificationChips.appendChild(heading);

  // Shares the exact same catalogue-driven widget the discovery flow uses
  // (renderCatalogueOptions, data/slots.json) instead of the old
  // getSlotOptions/findEnumOptionsForSlot approach, which only ever found
  // options by scanning a scheme's own eq/in eligibility conditions — so
  // any slot compared with lte/gte/between (child_age, annual_income, age,
  // ...) got zero options and silently rendered no buttons at all. slots.json
  // was already audited (M1) to cover every slot any scheme references, so
  // there's no coverage this drops.
  renderCatalogueOptions(clarificationChips, slot, (answer) => {
    if (answer !== DONT_KNOW) conversation.slots[slot] = answer;
    runEligibilityForFocusedScheme();
  });

  clarificationChips.hidden = false;
  if (shouldSpeak) speak(spokenText);
}

// Shared by the single-scheme verdict card (below) and D5's discovery
// results, where the same document-card markup is built once per eligible
// scheme rather than forked. Returns a DocumentFragment, not attached to
// anything yet — the caller decides where it lands.
function buildDocumentCards(documents) {
  const frag = document.createDocumentFragment();
  (documents || []).forEach((doc) => {
    // The whole card is the tap target (speaks label + where-to-get); the
    // 🔊 glyph is the visible affordance. A nested <button> inside a
    // <button> would be invalid HTML, so it's a span, not a control.
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'document-card';
    card.setAttribute('aria-label', `${doc.label_hi} — ${doc.where_to_get_hi} — सुनिए`);

    const illustration = document.createElement('img');
    illustration.className = 'document-card__illustration';
    illustration.src = doc.sample_image;
    illustration.alt = `${doc.label_hi} — प्रतीकात्मक चित्र`;
    illustration.loading = 'lazy';
    // Falls back to a generic document icon when a scheme-specific SVG
    // is missing (404) — self-clearing so a bad fallback can't loop.
    illustration.onerror = () => {
      illustration.onerror = null;
      illustration.src = 'assets/docs/document.svg';
    };

    const label = document.createElement('span');
    label.className = 'document-card__label';
    label.textContent = doc.label_hi;

    const where = document.createElement('span');
    where.className = 'document-card__where';
    where.textContent = doc.where_to_get_hi;

    const speakerIcon = document.createElement('span');
    speakerIcon.className = 'document-card__speaker-icon';
    speakerIcon.setAttribute('aria-hidden', 'true');
    speakerIcon.textContent = '🔊';

    card.addEventListener('click', () => speak(`${doc.label_hi}. कहाँ से लें: ${doc.where_to_get_hi}`));

    card.append(illustration, label, where, speakerIcon);
    frag.appendChild(card);
  });
  return frag;
}

// Same sharing rationale as buildDocumentCards above.
function buildCitationFragment(citation) {
  const frag = document.createDocumentFragment();
  if (!citation) return frag;
  frag.append(document.createTextNode('स्रोत: '));
  const link = document.createElement('a');
  link.href = citation.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = citation.url;
  frag.appendChild(link);
  if (citation.last_verified) {
    frag.append(document.createTextNode(` · ${citation.last_verified}`));
    const relative = formatRelativeVerifiedAge(citation.last_verified);
    if (relative) frag.append(document.createTextNode(` (${relative})`));
  }
  if (isPastReviewDue(citation.next_review_due)) {
    frag.append(document.createTextNode(' '));
    const badge = document.createElement('span');
    badge.className = 'staleness-badge';
    badge.setAttribute('role', 'status');
    badge.textContent = '⚠ समीक्षा अपेक्षित';
    frag.appendChild(badge);
  }
  return frag;
}

// ===== W1: WhatsApp share — plain-text summary via https://wa.me/?text=,
// no API/key/backend. Built straight from the same assembled/citation
// data already rendered on screen, so what's shared can never diverge
// from — or invent beyond — what the card itself says. =====
function buildShareTextForScheme(assembled) {
  const lines = [assembled.text_hi];

  if (assembled.documents && assembled.documents.length > 0) {
    lines.push('', 'ज़रूरी दस्तावेज़:');
    assembled.documents.forEach((doc) => lines.push(`- ${doc.label_hi}`));
  }

  if (assembled.citation) {
    lines.push('', `स्रोत: ${assembled.citation.url}`);
    if (assembled.citation.last_verified) {
      lines.push(`आखिरी सत्यापन: ${assembled.citation.last_verified}`);
    }
  }

  return lines.join('\n');
}

function openWhatsAppShare(text) {
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer');
}

function buildWhatsAppShareButton(getText) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'whatsapp-share-btn';
  btn.textContent = 'व्हाट्सएप पर भेजें';
  btn.addEventListener('click', () => openWhatsAppShare(getText()));
  return btn;
}

function renderVerdict(assembled, verdict, scheme, shouldSpeak) {
  hideAllResultZones();

  const isUnknownFallback = assembled.citation === null;
  verdictCard.className = 'verdict-card ' + (isUnknownFallback ? 'verdict-card--unknown' : (VERDICT_CARD_CLASS[verdict] || ''));
  verdictIcon.textContent = isUnknownFallback ? 'ℹ' : (VERDICT_ICONS[verdict] || '');
  verdictTitle.textContent = isUnknownFallback ? 'जानकारी उपलब्ध नहीं' : (VERDICT_BADGE_HI[verdict] || '');
  verdictSchemeName.textContent = assembled.text_hi;

  documentCardsEl.innerHTML = '';
  documentCardsEl.appendChild(buildDocumentCards(assembled.documents));

  verdictCitation.innerHTML = '';
  verdictCitation.appendChild(buildCitationFragment(assembled.citation));

  // W1: nothing meaningful to share when the app is refusing to answer.
  verdictShareBtn.hidden = isUnknownFallback;
  verdictShareBtn.onclick = () => openWhatsAppShare(buildShareTextForScheme(assembled));

  verdictCard.hidden = false;
  if (shouldSpeak) speak(assembled.text_hi);
}

// D5: a standalone card for the discovery results' eligible group — same
// markup/classes as the single-scheme #verdict-card above (built from the
// same buildDocumentCards/buildCitationFragment), just not tied to its
// fixed IDs, since several of these render at once.
function buildVerdictCardElement(assembled, verdict, scheme) {
  const card = document.createElement('article');
  card.className = 'verdict-card ' + (VERDICT_CARD_CLASS[verdict] || '');

  const header = document.createElement('div');
  header.className = 'verdict-card__header';
  const icon = document.createElement('span');
  icon.className = 'verdict-card__icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = VERDICT_ICONS[verdict] || '';
  const title = document.createElement('h3');
  title.className = 'verdict-card__title';
  title.textContent = VERDICT_BADGE_HI[verdict] || '';
  const speaker = document.createElement('button');
  speaker.type = 'button';
  speaker.className = 'speaker-btn';
  speaker.setAttribute('aria-label', 'सुनिए');
  speaker.textContent = '🔊';
  speaker.addEventListener('click', () => speak(assembled.text_hi));
  header.append(icon, title, speaker);

  const schemeName = document.createElement('p');
  schemeName.className = 'verdict-card__scheme-name';
  schemeName.textContent = assembled.text_hi;

  const docs = document.createElement('div');
  docs.className = 'document-cards';
  docs.appendChild(buildDocumentCards(assembled.documents));

  const citation = document.createElement('p');
  citation.className = 'verdict-card__citation';
  citation.appendChild(buildCitationFragment(assembled.citation));

  const shareBtn = buildWhatsAppShareButton(() => buildShareTextForScheme(assembled));

  card.append(header, schemeName, docs, citation, shareBtn);
  return card;
}

// ===== Discovery flow: core sequence, driven by data/slots.json =====
// `discoveryFlow.stack` holds the indices into core_sequence actually shown
// so far (for "back"); the last entry is on screen now. Every core question
// maps 1:1 to exactly one slot name, so "already answered" is just "is the
// slot set" — no per-step special cases needed (the old hardcoded flow's
// multi-select "household" step doesn't exist here: slots.json has no
// multi-type slot, and each slot it used to bundle — marital_status,
// disability_pct — now gets its own precise per-scheme follow-up instead
// of one coarse combined question).
function coreSequence() {
  return (slotsCatalogue && slotsCatalogue.core_sequence) || [];
}

function findNextCoreIndex(fromIndex) {
  const seq = coreSequence();
  for (let i = fromIndex; i < seq.length; i++) {
    if (!(seq[i] in conversation.slots)) return i;
  }
  return -1;
}

function advanceDiscovery(fromIndex) {
  const nextIndex = findNextCoreIndex(fromIndex);
  if (nextIndex === -1) {
    finishDiscoveryFlow();
    return;
  }
  discoveryFlow.stack.push(nextIndex);
  renderDiscoveryQuestion(true);
}

function goToPreviousDiscoveryStep() {
  if (!discoveryFlow || discoveryFlow.stack.length <= 1) return;
  discoveryFlow.stack.pop();
  renderDiscoveryQuestion(true);
}

function answerCoreQuestion(slotName, answer) {
  if (answer !== DONT_KNOW) conversation.slots[slotName] = answer;
  const currentIndex = discoveryFlow.stack[discoveryFlow.stack.length - 1];
  advanceDiscovery(currentIndex + 1);
}

function startDiscoveryFlow() {
  discoveryFlow = { stack: [] };
  advanceDiscovery(0);
}

// P2: re-evaluates every scheme against whatever core slots are known so
// far and renders a persistent "N eligible, M need more info" line above
// the current question — plus, once there's enough signal to be
// interesting, the eligible scheme names as chips and a "बस, अभी दिखाओ"
// shortcut. Reuses evaluateAll (same function operator.js and
// finishDiscoveryFlow use) so this can never disagree with the eventual
// full result for the same slots.
function renderDiscoveryLiveSummary(container, questionNumber) {
  const results = evaluateAll(conversation.slots, schemes);
  const eligible = results.filter(({ evaluation }) => evaluation.verdict === 'ELIGIBLE');
  const needInfo = results.filter(({ evaluation }) => evaluation.verdict === 'NEED_MORE_INFO');

  const wrap = document.createElement('div');
  wrap.className = 'discovery-live-summary';

  const text = document.createElement('p');
  text.className = 'discovery-live-summary__text';
  text.textContent = `अभी तक: ${eligible.length} योजनाएँ पात्र, ${needInfo.length} के लिए और जानकारी चाहिए`;
  wrap.appendChild(text);

  // Named after the second answer (question three onward) — before that,
  // one or two schemes surfacing by name reads as noise, not signal.
  if (questionNumber >= 3 && eligible.length > 0) {
    const chips = document.createElement('div');
    chips.className = 'discovery-live-summary__chips';
    eligible.forEach(({ scheme }) => {
      const chip = document.createElement('span');
      chip.className = 'discovery-live-chip';
      chip.textContent = scheme.name_hi;
      chips.appendChild(chip);
    });
    wrap.appendChild(chips);
  }

  if (questionNumber >= 3) {
    const quickShowBtn = document.createElement('button');
    quickShowBtn.type = 'button';
    quickShowBtn.className = 'chip-btn discovery-quickshow-btn';
    quickShowBtn.textContent = 'बस, अभी दिखाओ';
    quickShowBtn.addEventListener('click', () => finishDiscoveryFlow());
    wrap.appendChild(quickShowBtn);
  }

  container.appendChild(wrap);
}

function renderDiscoveryQuestion(shouldSpeak) {
  hideAllResultZones();
  clarificationChips.innerHTML = '';

  const seq = coreSequence();
  const index = discoveryFlow.stack[discoveryFlow.stack.length - 1];
  const slotName = seq[index];
  const def = findSlotDef(slotName);
  const questionNumber = discoveryFlow.stack.length;

  // "After each answer" — the first question has none yet, so there's
  // nothing live to summarise until question two.
  if (questionNumber >= 2) {
    renderDiscoveryLiveSummary(clarificationChips, questionNumber);
  }

  const progress = document.createElement('p');
  progress.className = 'discovery-progress';
  progress.textContent = `सवाल ${index + 1} / ${seq.length}`;
  clarificationChips.appendChild(progress);

  const heading = document.createElement('p');
  heading.className = 'answer-headline';
  heading.textContent = (def && def.question_hi) || slotName;
  clarificationChips.appendChild(heading);

  renderCatalogueOptions(clarificationChips, slotName, (answer) => answerCoreQuestion(slotName, answer));

  if (discoveryFlow.stack.length > 1) {
    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'chip-btn chip-btn--muted';
    backBtn.textContent = '← पिछला सवाल';
    backBtn.addEventListener('click', goToPreviousDiscoveryStep);
    clarificationChips.appendChild(backBtn);
  }

  clarificationChips.hidden = false;
  if (shouldSpeak && def) speak(def.question_hi);
}

// M1: each need-info card asks its own next missing slot inline, using
// data/slots.json — answering it (or "पता नहीं") re-evaluates and
// re-renders the whole discovery result (finishDiscoveryFlow), so a
// scheme that becomes ELIGIBLE visibly moves to that group, and a scheme
// still needing a second slot reappears here with its new question. This
// is the D4 gate's "income-gated schemes visibly surfaced" goal taken one
// step further: not just surfaced, but answerable in place.
function buildNeedInfoItem(scheme, evaluation) {
  // Only cite the first missing slot — one question at a time, matching
  // the rest of the app; assemble() already narrows its wording to
  // whichever missing_slots[0] we hand it.
  const slotName = evaluation.missing_slots[0];
  const narrowed = { ...evaluation, missing_slots: [slotName] };
  const assembled = assemble(evaluation.verdict, scheme, narrowed);

  const wrap = document.createElement('div');
  wrap.className = 'discovery-needinfo-item';

  const name = document.createElement('p');
  name.className = 'discovery-needinfo-item__scheme';
  name.textContent = scheme.name_hi;
  wrap.appendChild(name);

  const question = document.createElement('p');
  question.textContent = assembled.text_hi;
  wrap.appendChild(question);

  renderCatalogueOptions(wrap, slotName, (answer) => {
    if (answer !== DONT_KNOW) conversation.slots[slotName] = answer;
    finishDiscoveryFlow();
  });

  return wrap;
}

// D6 will replace this raw reasons dump with polished per-gap sentences
// (explainGap, built on the D1 gaps array). For now this mirrors exactly
// what the operator table already shows in its NOT_ELIGIBLE detail column
// (evaluation.reasons.join(' | ')) — reusing that same representation
// rather than inventing a second one.
// D6: one explainGap sentence per gap, replacing the raw reasons.join(' | ')
// D5 shipped as a placeholder for exactly this (see that commit's note).
// Falls back to the reasons dump only if a scheme somehow has no gaps for
// a NOT_ELIGIBLE verdict, which evaluate() shouldn't produce in practice.
function buildNotEligibleItem(scheme, evaluation) {
  const wrap = document.createElement('div');
  wrap.className = 'discovery-noteligible-item';

  const name = document.createElement('p');
  name.className = 'discovery-noteligible-item__scheme';
  name.textContent = scheme.name_hi;
  wrap.appendChild(name);

  if (evaluation.gaps.length > 0) {
    // Multiple any_of branches (e.g. one age threshold per category band)
    // can produce the same explainGap sentence more than once — de-dupe
    // by rendered text rather than showing the identical line repeatedly.
    const sentences = [...new Set(evaluation.gaps.map((gap) => explainGap(gap, scheme)))];
    sentences.forEach((sentence) => {
      const detail = document.createElement('p');
      detail.className = 'discovery-noteligible-item__detail';
      detail.textContent = sentence;
      wrap.appendChild(detail);
    });
  } else {
    const detail = document.createElement('p');
    detail.className = 'discovery-noteligible-item__detail';
    detail.textContent = evaluation.reasons.join(' | ');
    wrap.appendChild(detail);
  }

  return wrap;
}

function buildNearMissItem(scheme, gap) {
  const wrap = document.createElement('div');
  wrap.className = 'discovery-nearmiss-item';

  const sentence = explainGap(gap, scheme);

  const text = document.createElement('div');
  text.className = 'discovery-nearmiss-item__text';
  const name = document.createElement('span');
  name.className = 'discovery-nearmiss-item__scheme';
  name.textContent = scheme.name_hi;
  const detail = document.createElement('span');
  detail.textContent = sentence;
  text.append(name, detail);

  const speaker = document.createElement('button');
  speaker.type = 'button';
  speaker.className = 'speaker-btn';
  speaker.setAttribute('aria-label', 'सुनिए');
  speaker.textContent = '🔊';
  speaker.addEventListener('click', () => speak(`${scheme.name_hi}. ${sentence}`));

  wrap.append(text, speaker);
  return wrap;
}

// D5: the discovery flow's ranked result. evaluateAll (js/eligibility.js)
// is the exact same batch-evaluation function operator.js's schemes table
// and print checklist use, over the exact same conversation.slots object
// — so this can never disagree with what the operator view shows for
// identical slots.
function finishDiscoveryFlow() {
  discoveryFlow = null;
  hideAllResultZones();

  const results = evaluateAll(conversation.slots, schemes);
  const eligible = results.filter(({ evaluation }) => evaluation.verdict === 'ELIGIBLE');
  const needInfo = results.filter(({ evaluation }) => evaluation.verdict === 'NEED_MORE_INFO');
  const notEligible = results.filter(({ evaluation }) => evaluation.verdict === 'NOT_ELIGIBLE');

  discoveryEligibleHeading.textContent = `✅ आप इनके लिए पात्र लग रहे हैं (${eligible.length})`;
  discoveryEligibleCards.innerHTML = '';
  if (eligible.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'discovery-empty';
    empty.textContent = 'फिलहाल कोई योजना नहीं — नीचे देखें कि किनके लिए और जानकारी चाहिए';
    discoveryEligibleCards.appendChild(empty);
    discoveryShareAllBtn.hidden = true;
  } else {
    // W1: one combined message for every eligible scheme, separate from
    // each card's own single-scheme share button.
    const eligibleShareTexts = [];
    eligible.forEach(({ scheme, evaluation }) => {
      const assembled = assemble(evaluation.verdict, scheme, evaluation);
      discoveryEligibleCards.appendChild(buildVerdictCardElement(assembled, evaluation.verdict, scheme));
      eligibleShareTexts.push(buildShareTextForScheme(assembled));
    });
    discoveryShareAllBtn.hidden = false;
    discoveryShareAllBtn.onclick = () => openWhatsAppShare(eligibleShareTexts.join('\n\n---\n\n'));
  }

  discoveryNeedinfoHeading.textContent = `❓ इनके लिए थोड़ी और जानकारी चाहिए (${needInfo.length})`;
  discoveryNeedinfoList.innerHTML = '';
  needInfo.forEach(({ scheme, evaluation }) => {
    discoveryNeedinfoList.appendChild(buildNeedInfoItem(scheme, evaluation));
  });

  // D6: near-miss — schemes one numeric gap away from ELIGIBLE, ranked
  // closest-first. findNearMissGap (js/assemble.js) tests this by actually
  // patching in the fix and re-evaluating, not by counting raw gap leaves
  // — an any_of branch gated by an unrelated value (e.g. a different
  // gender's age threshold) can add gap noise from a branch the citizen
  // was never on. Pulled out of the general not-eligible bucket below
  // rather than shown in both.
  const nearMiss = notEligible
    .map(({ scheme, evaluation }) => ({ scheme, gap: findNearMissGap(conversation.slots, scheme, evaluation) }))
    .filter(({ gap }) => gap !== null)
    .map(({ scheme, gap }) => ({ scheme, gap, distance: gapDistance(gap) }))
    .sort((a, b) => a.distance - b.distance);
  const nearMissIds = new Set(nearMiss.map(({ scheme }) => scheme.scheme_id));
  const notEligibleRest = notEligible.filter(({ scheme }) => !nearMissIds.has(scheme.scheme_id));

  discoveryNearmissGroup.hidden = nearMiss.length === 0;
  discoveryNearmissHeading.textContent = `इन योजनाओं में आप थोड़ा सा दूर हैं (${nearMiss.length})`;
  discoveryNearmissList.innerHTML = '';
  nearMiss.forEach(({ scheme, gap }) => {
    discoveryNearmissList.appendChild(buildNearMissItem(scheme, gap));
  });

  discoveryNoteligibleToggle.textContent = `✕ इनमें अभी पात्र नहीं लग रहे (${notEligibleRest.length})`;
  discoveryNoteligibleToggle.setAttribute('aria-expanded', 'false');
  discoveryNoteligibleList.hidden = true;
  discoveryNoteligibleList.innerHTML = '';
  notEligibleRest.forEach(({ scheme, evaluation }) => {
    discoveryNoteligibleList.appendChild(buildNotEligibleItem(scheme, evaluation));
  });
  discoveryNoteligibleToggle.onclick = () => {
    const expanded = discoveryNoteligibleToggle.getAttribute('aria-expanded') === 'true';
    discoveryNoteligibleToggle.setAttribute('aria-expanded', String(!expanded));
    discoveryNoteligibleList.hidden = expanded;
  };

  discoveryResultsEl.hidden = false;

  // Speak only the summary + eligible names, never the full card list —
  // a screen reading itself out loud in a room isn't the goal here.
  const spoken = eligible.length > 0
    ? `आप ${eligible.length} योजनाओं के लिए पात्र लग रहे हैं। ${eligible.map(({ scheme }) => scheme.name_hi).join(', ')}`
    : 'फिलहाल आप किसी योजना के लिए पात्र नहीं लग रहे — नीचे देखें कि किनके लिए और जानकारी चाहिए';
  speak(spoken);

  refreshOperatorAfterTurn();
}

function findBandForNumber(options, number) {
  return options.find(({ value }) => {
    if (!value || typeof value !== 'object') return false;
    const lo = value.min === null || value.min === undefined ? -Infinity : value.min;
    const hi = value.max === null || value.max === undefined ? Infinity : value.max;
    return number >= lo && number <= hi;
  }) || null;
}

function isDontKnowUtterance(text) {
  return text.includes('पता नहीं') || text.includes('मालूम नहीं');
}

// Voice answers during a core discovery question are matched against the
// labels actually shown/spoken for THAT question — not routed through the
// general scheme router — since the whole point here is picking one of a
// small fixed set of options, not open-ended intent matching. Range-typed
// slots (age/income/...) are numeric, so a spoken figure ("मैं 25 साल की
// हूं") is matched against the band it falls into as a fallback when no
// label matched. district_select's options are just district names, so
// the same label match handles a spoken district for free. Known
// limitation: any rupee amount is matched as a bare number — a citizen who
// says a word like "हज़ार" isn't scaled, since Web Speech's transcript is
// what determines whether that comes through as digits.
function handleDiscoveryVoiceAnswer(rawTranscript) {
  const text = (rawTranscript || '').trim();
  if (!text || !discoveryFlow) return;

  const { normalised } = normalise(text, lexicon);
  renderTranscript(normalised);

  const index = discoveryFlow.stack[discoveryFlow.stack.length - 1];
  const slotName = coreSequence()[index];
  const def = findSlotDef(slotName);
  if (!def) return;

  if (isDontKnowUtterance(normalised)) {
    answerCoreQuestion(slotName, DONT_KNOW);
    return;
  }

  const options = optionsForSlotDef(def);
  if (options) {
    const matched = options.find(({ label, value }) => value !== null && normalised.includes(label));
    if (matched) { answerCoreQuestion(slotName, matched.value); return; }

    if (def.type === 'range_select') {
      const number = extractBareNumber(normalised);
      const band = number !== null ? findBandForNumber(options, number) : null;
      if (band) { answerCoreQuestion(slotName, band.value); return; }
    }
  }

  speak('समझ नहीं आया — कोई विकल्प चुनें या दोबारा बोलिए');
}

// ===== Core turn logic =====
// isRealTurn=false is used when the operator's own slot-table edit
// triggered this (via onSlotsChanged): a full operator refresh there would
// rebuild the slot table mid-edit and steal focus from the input the
// operator is actively typing in, and speaking the result aloud on every
// keystroke would be equally wrong — the operator isn't looking at the
// citizen card. The operator side already updates its own schemes
// table/print area itself in that case.
function runEligibilityForFocusedScheme(isRealTurn = true) {
  const scheme = schemes.find((s) => s.scheme_id === conversation.schemeId);
  if (!scheme) return;

  const evaluation = evaluate(conversation.slots, scheme);

  if (evaluation.verdict === 'NEED_MORE_INFO') {
    // Ask about exactly one missing slot per turn, so the spoken question
    // matches what's actually being offered — not the full remaining list.
    conversation.awaitingSlot = evaluation.missing_slots[0] || null;
    const singleSlotEvaluation = { ...evaluation, missing_slots: [conversation.awaitingSlot] };
    const assembled = assemble(evaluation.verdict, scheme, singleSlotEvaluation);
    renderSlotQuestion(scheme, conversation.awaitingSlot, assembled.text_hi, isRealTurn);
  } else {
    conversation.awaitingSlot = null;
    const assembled = assemble(evaluation.verdict, scheme, evaluation);
    renderVerdict(assembled, evaluation.verdict, scheme, isRealTurn);
  }

  if (isRealTurn) refreshOperatorAfterTurn();
}

function handleInput(rawText) {
  const text = (rawText || '').trim();
  if (!text) return;

  // A typed/spoken query is an unambiguous signal to leave whatever
  // discovery question was on screen — same as any other topic change.
  discoveryFlow = null;

  if (sessionStartTime === null) sessionStartTime = Date.now();

  renderTranscript(text);

  const { normalised, substitutions } = normalise(text, lexicon);
  renderNormalisation(normalised, substitutions);

  const routed = route(normalised, schemes);
  Object.assign(conversation.slots, routed.slots);

  if (routed.intent === 'discover') {
    conversation.schemeId = null;
    conversation.awaitingSlot = null;
    startDiscoveryFlow();
    return;
  }

  if (conversation.schemeId && conversation.awaitingSlot) {
    if (!(conversation.awaitingSlot in routed.slots)) {
      const bareNumber = extractBareNumber(normalised);
      if (bareNumber !== null) conversation.slots[conversation.awaitingSlot] = bareNumber;
    }
    runEligibilityForFocusedScheme();
    return;
  }

  if (routed.confidence >= CONFIDENCE_THRESHOLD && routed.scheme_ids.length === 1) {
    logConfidencePath('confident-match', routed.confidence);
    conversation.schemeId = routed.scheme_ids[0];
    conversation.awaitingSlot = null;
    runEligibilityForFocusedScheme();
    return;
  }

  // S3: a mid-range confidence transcript is more likely a real question
  // heard slightly wrong than noise — read it back and let the citizen
  // confirm, rather than jumping straight to "मुझे समझ नहीं आया".
  if (routed.confidence >= CONFIRM_HEARD_MIN_CONFIDENCE) {
    logConfidencePath('confirm-heard', routed.confidence);
    renderHeardConfirmation(normalised, routed);
    return;
  }

  logConfidencePath('low-confidence-direct', routed.confidence);
  proceedWithLowConfidenceFallback(routed);
}

// S3: shared by the confidence<0.3 direct path and the "हाँ, यही पूछा था"
// branch of the confirmation prompt, so the two can't drift into
// different behaviour for what's really the same "give up on routing,
// show clarification/fallback" outcome.
function proceedWithLowConfidenceFallback(routed) {
  conversation.schemeId = null;
  conversation.awaitingSlot = null;

  const candidates = routed.scheme_ids.map((id) => schemes.find((s) => s.scheme_id === id)).filter(Boolean);
  if (candidates.length > 0) {
    renderClarificationSchemes(candidates);
  } else {
    showFallback(NO_MATCH_MESSAGE_HI);
  }

  refreshOperatorAfterTurn();
}

// S3: console-only, ephemeral — never persisted (no transcript storage,
// per the hard "no PII persisted" constraint), just enough for a field
// tester watching devtools to tally which confidence path citizens
// actually hit.
function logConfidencePath(path, confidence) {
  console.log(`[VAANI field-notes] confidence path: ${path} (confidence=${confidence.toFixed(2)})`);
}

function renderHeardConfirmation(normalisedText, routed) {
  hideAllResultZones();
  clarificationChips.innerHTML = '';

  const promptText = `मैंने सुना — ${normalisedText}. क्या यह सही है?`;

  const heading = document.createElement('p');
  heading.className = 'answer-headline';
  heading.textContent = promptText;
  clarificationChips.appendChild(heading);

  const optionsWrap = document.createElement('div');
  optionsWrap.className = 'discovery-options';

  const yesBtn = document.createElement('button');
  yesBtn.type = 'button';
  yesBtn.className = 'chip-btn chip-btn--large';
  yesBtn.textContent = 'हाँ';
  yesBtn.addEventListener('click', () => {
    logConfidencePath('confirm-heard-yes', routed.confidence);
    proceedWithLowConfidenceFallback(routed);
  });

  const noBtn = document.createElement('button');
  noBtn.type = 'button';
  noBtn.className = 'chip-btn chip-btn--large chip-btn--muted';
  noBtn.textContent = 'नहीं';
  noBtn.addEventListener('click', () => {
    logConfidencePath('confirm-heard-no', routed.confidence);
    hideAllResultZones();
    startListening();
  });

  optionsWrap.append(yesBtn, noBtn);
  clarificationChips.appendChild(optionsWrap);
  clarificationChips.hidden = false;

  speak(promptText);
}

// ===== Wiring =====
function disableMicPermanently(message) {
  showFallback(message);
  micButton.disabled = true;
}

// Shared by the citizen mic button and the operator view's Space shortcut.
function startListening() {
  if (!isRecognitionSupported()) {
    disableMicPermanently('इस ब्राउज़र में माइक सुविधा उपलब्ध नहीं है — नीचे से कोई सवाल चुनें या टाइप करें');
    return;
  }
  // S2: a long spoken answer must always be interruptible by tapping the
  // mic again, not queue behind it.
  cancelSpeech();
  micButton.classList.add('is-listening');
  micStatus.textContent = 'सुन रहे हैं';
  renderTranscript('');
  listen(
    ({ transcript, isFinal }) => {
      renderTranscript(transcript);
      if (isFinal) {
        micButton.classList.remove('is-listening');
        micStatus.textContent = '';
        // The mic button is shared: during a discovery question it answers
        // that question (matched against the current options), otherwise
        // it's a normal query through the router.
        if (discoveryFlow) handleDiscoveryVoiceAnswer(transcript);
        else handleInput(transcript);
      }
    },
    ({ type, message }) => {
      micButton.classList.remove('is-listening');
      micStatus.textContent = '';
      if (type === 'unsupported' || type === 'permission-denied') {
        // Mic genuinely cannot be used at all — fall back to chips/typed input.
        showFallback(message + ' — नीचे से कोई सवाल चुनें या टाइप करें');
      } else {
        // Recoverable (no-speech / timeout / start-failed): real mobile
        // recognition ends without a result fairly often for benign reasons
        // (a short pause, quiet speech). Just let the citizen retry — do
        // NOT wipe whatever question/verdict is already on screen.
        renderTranscript(message + ' — दोबारा बोलिए');
      }
    }
  );
}

function wireMicButton() {
  if (!isRecognitionSupported()) {
    disableMicPermanently('इस ब्राउज़र में माइक सुविधा उपलब्ध नहीं है — नीचे से कोई सवाल चुनें या टाइप करें');
    return;
  }
  micButton.addEventListener('click', startListening);
}

function setMode(mode) {
  const isOperator = mode === 'emitra';
  appMain.hidden = isOperator;
  operatorViewEl.hidden = !isOperator;

  modeCitizenBtn.classList.toggle('mode-btn--active', !isOperator);
  modeCitizenBtn.setAttribute('aria-pressed', String(!isOperator));
  modeEmitraBtn.classList.toggle('mode-btn--active', isOperator);
  modeEmitraBtn.setAttribute('aria-pressed', String(isOperator));
  document.body.classList.toggle('operator-mode', isOperator);

  if (isOperator) activateOperatorView();
  else deactivateOperatorView();
}

function wireModeToggle() {
  modeCitizenBtn.addEventListener('click', () => setMode('citizen'));
  modeEmitraBtn.addEventListener('click', () => setMode('emitra'));
}

function wireTypedInput() {
  typedForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = typedInput.value.trim();
    typedInput.value = '';
    if (value) handleInput(value);
  });
}

// S1: reacts to js/speech.js's voice detection. Toggling body.tts-degraded
// (see css/vaani.css) disables every .speaker-btn via pointer-events —
// including ones created later by discovery/verdict rendering, which a
// one-time disabled-attribute pass here couldn't reach. The notice banner
// keeps all response text visible; nothing is hidden, only the audio.
function applyTtsDegradedUi(state) {
  const notice = document.getElementById('tts-degraded-notice');
  if (notice) notice.hidden = !state.ttsDegraded;
  document.body.classList.toggle('tts-degraded', state.ttsDegraded);
}

function wireSpeakerButtons() {
  document.querySelectorAll('.speaker-btn[data-speak-target]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = document.querySelector(btn.dataset.speakTarget);
      const text = target && target.textContent.trim();
      if (text) speak(text);
    });
  });
}

// Shown on load (and after every reset) so a first-time citizen — or an
// evaluator who won't speak Hindi into a laptop mic — sees what they can ask
// instead of a blank screen with one button. Capped at 4: enough to show the
// range of questions without turning the first screen into a scheme list.
const FALLBACK_SAMPLE_COUNT = 4;

async function populateFallbackChips() {
  try {
    const res = await fetch('data/samples.json');
    const data = await res.json();
    (data.samples || []).slice(0, FALLBACK_SAMPLE_COUNT).forEach(({ query_hi }) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'fallback-chip';

      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip-btn';
      chip.textContent = query_hi;
      chip.addEventListener('click', () => handleInput(query_hi));

      // A non-reading citizen can hear the question before committing to it —
      // tapping the chip itself immediately asks it, so preview needs its own control.
      const speaker = document.createElement('button');
      speaker.type = 'button';
      speaker.className = 'speaker-btn';
      speaker.setAttribute('aria-label', `सुनिए: ${query_hi}`);
      speaker.textContent = '🔊';
      speaker.addEventListener('click', () => speak(query_hi));

      wrapper.append(chip, speaker);
      fallbackChips.appendChild(wrapper);
    });
  } catch (_) {
    // Sample chips are a convenience; typed input still works without them.
  }
}

// ===== Disclosure panel — reachable from the header on every screen.
// Counts are pulled from the loaded JSON at render time so they can never
// drift from what's actually shipped. =====
// S1: voice name + degraded state pulled live from js/speech.js's own
// detection, so this line can't say "working" on a device where speak()
// is actually refusing to speak.
function ttsDisclosureLine() {
  const { ttsDegraded, voiceName } = getTtsVoiceInfo();
  if (ttsDegraded) {
    return `बोली जाने वाली प्रतिक्रियाएं — इस डिवाइस पर हिन्दी आवाज़ उपलब्ध नहीं है (पता चली आवाज़: ${voiceName || 'कोई नहीं'})`;
  }
  return `बोली जाने वाली प्रतिक्रियाएं (आवाज़: ${voiceName || 'पता चल रहा है...'})`;
}

function disclosureLiveItems() {
  const lexiconCount = lexicon && lexicon.map ? Object.keys(lexicon.map).length : '—';
  const lexiconVersion = (lexicon && lexicon.version) || '—';
  const schemeCount = schemes ? schemes.length : '—';
  return [
    'माइक भाषण पहचान (Web Speech API, hi-IN)',
    `राजस्थानी शब्दावली सामान्यीकरण (${lexiconCount} प्रविष्टियाँ, संस्करण ${lexiconVersion})`,
    `निर्धारक पात्रता इंजन (${schemeCount} योजनाएं, सभी नियम यूनिट-टेस्टेड)`,
    ttsDisclosureLine(),
    'दस्तावेज़ चेकलिस्ट (document checklists)',
    'ऑफ़लाइन संचालन — कैश से (offline from cache)',
    'ई-मित्र संचालक मोड (e-Mitra operator mode)',
  ];
}

const DISCLOSURE_SIMULATED_ITEMS_HI = [
  'जन आधार API — Integration Doc v1.8 के अनुसार स्पेक-सटीक, कोई वास्तविक डेटा नहीं, DoIT&C ऑनबोर्डिंग आवश्यक',
  'WhatsApp चैनल (Phase 2)',
  'टेलीफोनी / IVR (Phase 3)',
  'बोली-विशिष्ट ध्वन्यात्मक ASR — केवल शब्दावली स्तर; ध्वन्यात्मक मॉडल हेतु लेबल किए गए राजस्थानी भाषण डेटा चाहिए, जो पायलट उत्पन्न करेगा',
];

function renderDisclosurePanel() {
  const liveList = document.getElementById('disclosure-live-list');
  const simList = document.getElementById('disclosure-simulated-list');
  liveList.innerHTML = '';
  simList.innerHTML = '';

  disclosureLiveItems().forEach((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    liveList.appendChild(li);
  });

  DISCLOSURE_SIMULATED_ITEMS_HI.forEach((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    simList.appendChild(li);
  });
}

function wireDisclosurePanel() {
  const trigger = document.getElementById('disclosure-trigger');
  const modal = document.getElementById('disclosure-modal');
  const closeBtn = document.getElementById('disclosure-close');
  if (!trigger || !modal) return;
  trigger.addEventListener('click', () => {
    renderDisclosurePanel();
    modal.hidden = false;
  });
  closeBtn.addEventListener('click', () => {
    modal.hidden = true;
  });
}

function wireDiscoveryEntry() {
  if (!discoveryEntryBtn) return;
  discoveryEntryBtn.addEventListener('click', startDiscoveryFlow);
}

async function init() {
  registerServiceWorker();
  initTts(applyTtsDegradedUi);
  wireSpeakerButtons();
  wireTypedInput();
  wireModeToggle();
  wireDisclosurePanel();
  wireDiscoveryEntry();
  await populateFallbackChips();

  try {
    [lexicon, schemes] = await Promise.all([loadLexiconCached(), loadSchemesCached()]);
  } catch (err) {
    disableMicPermanently(LOAD_ERROR_HI);
    return;
  }

  // slots.json powers the discovery flow's questions but nothing else the
  // app does — its own failure shouldn't take down schemes/lexicon-backed
  // features that don't need it.
  let slotsLoadError = null;
  try {
    slotsCatalogue = await loadSlotsCached();
  } catch (err) {
    slotsLoadError = err;
    slotsCatalogue = null;
  }
  validateSlotsCoverage();
  if (slotsLoadError) {
    console.warn('[VAANI] data/slots.json failed to load — discovery follow-up questions will show "जानकारी अधूरी".', slotsLoadError);
  }

  wireMicButton();

  initOperator({
    schemes,
    conversation,
    onSlotsChanged: () => {
      if (conversation.schemeId) runEligibilityForFocusedScheme(false);
    },
    startListening,
    resetConversation,
    getSessionElapsedSeconds,
  });

  initJanAadhaar({
    onAutofill: (slots) => {
      Object.assign(conversation.slots, slots);
      if (conversation.schemeId) runEligibilityForFocusedScheme();
      else refreshOperatorAfterTurn();
    },
  });
}

window.addEventListener('beforeunload', stopListening);
init();
