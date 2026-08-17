import { evaluateAll } from './eligibility.js';

// Same engine as the citizen view (eligibility.js), denser surface. This
// module owns the operator DOM subtree only; app.js owns the shared
// `conversation` state object and passes it in by reference via initOperator
// so edits here are immediately visible to the citizen flow too.

const ALL_SLOT_KEYS = [
  'age', 'child_age', 'gender', 'marital_status', 'annual_income',
  'residency_years', 'child_status', 'disability_pct', 'category',
  'birth_date', 'birth_facility_type', 'family_girls_count', 'occupation',
  'landholding_hectares', 'group_farmer_count', 'group_landholding_hectares',
  'education_level', 'employment_registered', 'district', 'health_cover_category',
];

const SLOT_LABELS_HI = {
  age: 'आयु', child_age: 'बच्चे की आयु', gender: 'लिंग', marital_status: 'वैवाहिक स्थिति',
  annual_income: 'वार्षिक आय', residency_years: 'निवास के वर्ष', child_status: 'बच्चे की स्थिति',
  disability_pct: 'निशक्तता %', category: 'श्रेणी', birth_date: 'जन्म तिथि',
  birth_facility_type: 'जन्म स्थान', family_girls_count: 'बालिकाओं की संख्या', occupation: 'व्यवसाय',
  landholding_hectares: 'भूमि (हेक्टेयर)', group_farmer_count: 'समूह कृषक संख्या',
  group_landholding_hectares: 'समूह भूमि (हेक्टेयर)', education_level: 'शिक्षा स्तर',
  employment_registered: 'रोजगार पंजीकरण', district: 'जिला',
  health_cover_category: 'श्रेणी (निःशुल्क/प्रीमियम)',
};

const NUMERIC_SLOTS = new Set([
  'age', 'child_age', 'annual_income', 'residency_years', 'disability_pct',
  'family_girls_count', 'landholding_hectares', 'group_farmer_count', 'group_landholding_hectares',
]);
const BOOLEAN_SLOTS = new Set(['employment_registered']);
const DATE_SLOTS = new Set(['birth_date']);

// Autocomplete hints only (datalist) — the operator can still type any
// value; these aren't a rigid enum the way the citizen tap-flow options are.
const VALUE_SUGGESTIONS_HI = {
  gender: ['male', 'female'],
  marital_status: ['widow', 'divorced', 'abandoned', 'married', 'unmarried'],
  child_status: ['orphan', 'single_parent_child', 'special_needs_or_ill_parent_child'],
  category: ['general', 'sc', 'st', 'dwarfism', 'transgender'],
  birth_facility_type: ['government', 'jsy_empaneled_private'],
  occupation: ['farmer', 'labourer', 'student', 'unemployed'],
  education_level: ['graduate'],
  health_cover_category: ['nfsa', 'secc_2011', 'small_marginal_farmer', 'contract_worker', 'covid_exgratia_recipient', 'other'],
};

const VERDICT_LABEL_HI = { ELIGIBLE: 'पात्र', NOT_ELIGIBLE: 'अपात्र', NEED_MORE_INFO: 'जानकारी चाहिए' };
const VERDICT_ROW_CLASS = {
  ELIGIBLE: 'operator-row--eligible',
  NOT_ELIGIBLE: 'operator-row--not-eligible',
  NEED_MORE_INFO: 'operator-row--need-info',
};

// X3: a small local copy of app.js's same date-diff check — not imported,
// to avoid a circular import (app.js already imports from this module).
function isPastReviewDue(nextReviewDue) {
  if (!nextReviewDue) return false;
  const due = new Date(`${nextReviewDue}T00:00:00`);
  if (Number.isNaN(due.getTime())) return false;
  return Date.now() > due.getTime();
}

let ctx = null; // { schemes, conversation, onSlotsChanged, startListening, resetConversation, getSessionElapsedSeconds }
let timerHandle = null;

export function initOperator(context) {
  ctx = context;
  wirePrintButton();
  wireKeyboardShortcuts();
}

export function activateOperatorView() {
  renderAll();
  startTimer();
}

export function deactivateOperatorView() {
  stopTimer();
}

// Called by app.js after any turn that isn't an operator-table edit (voice
// input, typed input, chip tap) so the operator view stays in sync even
// while it's the visible surface.
export function refreshOperatorAfterTurn() {
  if (!ctx) return;
  renderAll();
}

function renderAll() {
  renderTranscriptPanel();
  renderSlotTable();
  renderSchemesTable();
  renderPrintArea();
}

// ===== Session timer =====
function startTimer() {
  stopTimer();
  updateTimerDisplay();
  timerHandle = setInterval(updateTimerDisplay, 1000);
}

function stopTimer() {
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = null;
}

function updateTimerDisplay() {
  const el = document.getElementById('operator-timer');
  if (!el) return;
  const seconds = ctx.getSessionElapsedSeconds();
  if (seconds === null) {
    el.textContent = 'सत्र समय: —';
    return;
  }
  const m = String(Math.floor(seconds / 60)).padStart(2, '0');
  const s = String(Math.floor(seconds % 60)).padStart(2, '0');
  el.textContent = `सत्र समय: ${m}:${s}`;
}

// ===== Transcript panel (raw + normalised, both always visible) =====
function renderTranscriptPanel() {
  const rawEl = document.getElementById('transcript-line');
  const normEl = document.getElementById('normalisation-line');
  const normBlock = document.getElementById('normalisation-block');

  document.getElementById('operator-raw-transcript').textContent = (rawEl && rawEl.textContent) || '—';
  document.getElementById('operator-normalised-transcript').textContent =
    (normBlock && !normBlock.hidden && normEl) ? normEl.textContent : '(कोई शब्द बदलाव नहीं)';
}

// ===== Editable slot table =====
function renderSlotTable() {
  const tbody = document.getElementById('operator-slot-table-body');
  tbody.innerHTML = '';

  ALL_SLOT_KEYS.forEach((slot) => {
    const tr = document.createElement('tr');

    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = `${SLOT_LABELS_HI[slot] || slot}`;
    tr.appendChild(th);

    const td = document.createElement('td');
    td.appendChild(buildSlotInput(slot));
    tr.appendChild(td);

    tbody.appendChild(tr);
  });
}

function buildSlotInput(slot) {
  const currentValue = ctx.conversation.slots[slot];
  let input;

  if (BOOLEAN_SLOTS.has(slot)) {
    input = document.createElement('select');
    [['', '—'], ['true', 'हाँ'], ['false', 'नहीं']].forEach(([value, label]) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      input.appendChild(opt);
    });
    input.value = currentValue === undefined ? '' : String(currentValue);
    input.addEventListener('change', () => {
      setSlot(slot, input.value === '' ? undefined : input.value === 'true');
    });
  } else if (DATE_SLOTS.has(slot)) {
    input = document.createElement('input');
    input.type = 'date';
    input.value = currentValue || '';
    input.addEventListener('change', () => setSlot(slot, input.value || undefined));
  } else if (NUMERIC_SLOTS.has(slot)) {
    input = document.createElement('input');
    input.type = 'number';
    input.value = currentValue === undefined ? '' : currentValue;
    input.addEventListener('input', () => {
      setSlot(slot, input.value === '' ? undefined : Number(input.value));
    });
  } else {
    input = document.createElement('input');
    input.type = 'text';
    input.value = currentValue === undefined ? '' : currentValue;
    const suggestions = VALUE_SUGGESTIONS_HI[slot];
    if (suggestions) {
      const listId = `operator-suggest-${slot}`;
      input.setAttribute('list', listId);
      if (!document.getElementById(listId)) {
        const dl = document.createElement('datalist');
        dl.id = listId;
        suggestions.forEach((v) => {
          const opt = document.createElement('option');
          opt.value = v;
          dl.appendChild(opt);
        });
        document.body.appendChild(dl);
      }
    }
    input.addEventListener('input', () => {
      const trimmed = input.value.trim();
      setSlot(slot, trimmed === '' ? undefined : trimmed);
    });
  }

  input.className = 'operator-slot-input';
  input.id = `operator-slot-${slot}`;
  return input;
}

// Mutates the SAME conversation.slots object app.js holds — no copying, so
// switching back to the citizen view sees the correction immediately.
function setSlot(slot, value) {
  if (value === undefined) delete ctx.conversation.slots[slot];
  else ctx.conversation.slots[slot] = value;

  // Re-render only the outputs, not the table itself — rebuilding the slot
  // table here would destroy the input the operator is actively typing in
  // and steal focus after every keystroke.
  renderSchemesTable();
  renderPrintArea();
  if (ctx.onSlotsChanged) ctx.onSlotsChanged();
}

// ===== All-schemes eligibility breakdown =====
function renderSchemesTable() {
  const tbody = document.getElementById('operator-schemes-table-body');
  tbody.innerHTML = '';

  evaluateAll(ctx.conversation.slots, ctx.schemes).forEach(({ scheme, evaluation }) => {
    const tr = document.createElement('tr');
    tr.className = VERDICT_ROW_CLASS[evaluation.verdict] || '';

    const nameTd = document.createElement('td');
    nameTd.innerHTML = '';
    const nameStrong = document.createElement('strong');
    nameStrong.textContent = scheme.name_hi;
    const idSmall = document.createElement('small');
    idSmall.className = 'operator-scheme-id';
    idSmall.textContent = scheme.scheme_id;
    nameTd.append(nameStrong, document.createElement('br'), idSmall);
    tr.appendChild(nameTd);

    const verdictTd = document.createElement('td');
    verdictTd.textContent = VERDICT_LABEL_HI[evaluation.verdict] || evaluation.verdict;
    tr.appendChild(verdictTd);

    const detailTd = document.createElement('td');
    detailTd.className = 'operator-detail-cell';
    if (evaluation.verdict === 'NEED_MORE_INFO') {
      detailTd.textContent = 'चाहिए: ' + evaluation.missing_slots.map((s) => SLOT_LABELS_HI[s] || s).join(', ');
    } else {
      detailTd.textContent = evaluation.reasons.join(' | ');
    }
    tr.appendChild(detailTd);

    const citationTd = document.createElement('td');
    if (evaluation.verdict === 'ELIGIBLE' && scheme.source_url) {
      const link = document.createElement('a');
      link.href = scheme.source_url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'स्रोत';
      citationTd.appendChild(link);
      citationTd.append(document.createTextNode(` · ${scheme.last_verified || ''}`));
      if (isPastReviewDue(scheme.next_review_due)) {
        citationTd.append(document.createTextNode(' '));
        const badge = document.createElement('span');
        badge.className = 'staleness-badge';
        badge.textContent = '⚠ समीक्षा अपेक्षित';
        citationTd.appendChild(badge);
      }
    }
    tr.appendChild(citationTd);

    tbody.appendChild(tr);
  });
}

// ===== Print checklist (also what Ctrl+P produces via @media print) =====
function renderPrintArea() {
  const container = document.getElementById('operator-print-area');
  container.innerHTML = '';

  const heading = document.createElement('h2');
  heading.textContent = 'दस्तावेज़ चेकलिस्ट — VAANI';
  container.appendChild(heading);

  const generatedAt = document.createElement('p');
  generatedAt.textContent = `तैयार किया गया: ${new Date().toLocaleString('hi-IN')}`;
  container.appendChild(generatedAt);

  const eligible = evaluateAll(ctx.conversation.slots, ctx.schemes)
    .filter(({ evaluation }) => evaluation.verdict === 'ELIGIBLE');

  if (eligible.length === 0) {
    const p = document.createElement('p');
    p.textContent = 'अभी कोई योजना पात्र के रूप में चिह्नित नहीं है।';
    container.appendChild(p);
  }

  eligible.forEach(({ scheme }) => {
    const block = document.createElement('div');
    block.className = 'print-scheme-block';

    const h3 = document.createElement('h3');
    h3.textContent = scheme.name_hi;
    block.appendChild(h3);

    const ul = document.createElement('ul');
    (scheme.documents || []).forEach((doc) => {
      const li = document.createElement('li');
      li.textContent = `${doc.label_hi} — ${doc.where_to_get_hi}`;
      ul.appendChild(li);
    });
    block.appendChild(ul);
    container.appendChild(block);
  });

  const footer = document.createElement('p');
  footer.className = 'print-footer';
  footer.textContent = 'ई-मित्र पर पुष्टि करें / Verify at e-Mitra — यह एक स्वचालित सुझाव सूची है, अंतिम निर्णय नहीं।';
  container.appendChild(footer);
}

function wirePrintButton() {
  const btn = document.getElementById('operator-print-btn');
  if (btn) btn.addEventListener('click', () => window.print());
}

// Space = listen, Esc = reset — only while the operator view is the active
// surface, and never while the operator is typing into a form field.
function wireKeyboardShortcuts() {
  document.addEventListener('keydown', (event) => {
    const view = document.getElementById('operator-view');
    if (!view || view.hidden) return;

    const tag = (event.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

    if (event.code === 'Space') {
      event.preventDefault();
      ctx.startListening();
    } else if (event.key === 'Escape') {
      ctx.resetConversation();
      renderAll();
    }
  });
}
