// R4 — VAANI embed widget. One line of HTML any department can embed:
//   <script src="https://.../embed/vaani-embed.js" data-scheme="RJ_PALANHAR"></script>
//
// Deliberately a classic (non-module) script, not type="module" — that's
// what makes document.currentScript reliable for finding this exact tag's
// data-scheme attribute and its own src URL, which everything else here is
// resolved relative to (so the widget works correctly regardless of what
// domain embeds it, not just when served from this app's own origin).
//
// It reads scheme facts from /api/v1/schemes/{id}.json — the same
// published registry api/v1/build-registry.mjs generates from
// data/schemes.json — and dynamically imports js/eligibility.js and
// js/assemble.js (both already dependency-free pure modules) from this
// same deployment to compute the verdict and the response wording. That's
// a stronger guarantee than "reads the same data": it runs the exact same
// verdict CODE the main app runs, so it cannot compute a different answer
// from the same slots, not just "is unlikely to".
//
// Renders inside a shadow root (host CSS can't reach in, this widget's
// CSS can't leak out) and degrades to a plain link on any failure — a
// bad scheme id, a network error, a missing api/v1/ file, or a failed
// dynamic import all land in the same degraded-link path.
(function () {
  'use strict';

  function resolveScriptUrl() {
    if (document.currentScript && document.currentScript.src) {
      return new URL(document.currentScript.src, document.baseURI);
    }
    // Fallback for the rare host that loads this without leaving
    // document.currentScript set (e.g. some legacy async-injection
    // patterns) — last matching <script> tag on the page.
    var scripts = document.querySelectorAll('script[src*="vaani-embed.js"]');
    if (scripts.length > 0) {
      return new URL(scripts[scripts.length - 1].src, document.baseURI);
    }
    return null;
  }

  var scriptEl = document.currentScript;
  var scriptUrl = resolveScriptUrl();
  var schemeId = scriptEl && scriptEl.getAttribute('data-scheme');

  if (!scriptUrl || !schemeId) return; // nothing sensible to render

  // '../' relative to this script's own URL (e.g. https://host/vaani/embed/
  // vaani-embed.js -> https://host/vaani/) — standard relative resolution,
  // not string-matching the filename, so this still works if the script
  // is ever served under a different name or an extra path segment.
  var BASE = new URL('../', scriptUrl).href;
  var SCHEME_URL = BASE + 'api/v1/schemes/' + encodeURIComponent(schemeId) + '.json';
  var ELIGIBILITY_URL = BASE + 'js/eligibility.js';
  var ASSEMBLE_URL = BASE + 'js/assemble.js';
  var APP_URL = BASE + 'index.html';
  var FONT_HI_URL = BASE + 'assets/fonts/NotoSansDevanagari-Variable.ttf';
  var FONT_LATIN_URL = BASE + 'assets/fonts/Inter-Variable.ttf';

  // Small, hand-maintained Hindi vocabulary for slot questions and enum
  // value labels. This IS a duplicate of vocabulary that also lives in
  // data/slots.json and js/operator.js — unavoidable here: this file must
  // stand alone from a host page that has none of this app's other assets
  // loaded, and data/slots.json isn't part of the versioned api/v1/
  // contract this widget is scoped to depend on. Kept intentionally small
  // (only slot names that actually appear in some scheme's eligibility) —
  // an unknown slot/value still renders (as its raw identifier), it just
  // isn't as polished as the main app's fully-catalogued question flow.
  var SLOT_QUESTIONS_HI = {
    age: 'आपकी उम्र क्या है?',
    child_age: 'बच्चे की उम्र क्या है?',
    gender: 'आपका लिंग क्या है?',
    marital_status: 'आपकी वैवाहिक स्थिति क्या है?',
    annual_income: 'वार्षिक आय कितनी है? (₹ में)',
    residency_years: 'राजस्थान में कितने वर्षों से निवास है?',
    child_status: 'बच्चे की स्थिति क्या है?',
    disability_pct: 'निशक्तता प्रतिशत कितना है?',
    category: 'आपकी श्रेणी क्या है?',
    birth_date: 'जन्म तिथि क्या है?',
    birth_facility_type: 'जन्म कहाँ हुआ?',
    family_girls_count: 'परिवार में कुल बालिकाएं कितनी हैं?',
    occupation: 'आपका व्यवसाय क्या है?',
    landholding_hectares: 'भूमि कितने हेक्टेयर है?',
    group_farmer_count: 'समूह में कृषक कितने हैं?',
    group_landholding_hectares: 'समूह की भूमि कितने हेक्टेयर है?',
    education_level: 'शिक्षा स्तर क्या है?',
    employment_registered: 'क्या आप रोजगार कार्यालय में पंजीकृत हैं?',
    district: 'आपका जिला कौनसा है?',
    health_cover_category: 'आपकी श्रेणी क्या है (निःशुल्क/प्रीमियम पर)?',
  };

  var VALUE_LABELS_HI = {
    orphan: 'अनाथ', single_parent_child: 'एकल अभिभावक की संतान',
    special_needs_or_ill_parent_child: 'विशेष योग्यजन/बीमार माता-पिता की संतान',
    female: 'महिला', male: 'पुरुष', transgender: 'ट्रांसजेंडर',
    widow: 'विधवा', divorced: 'तलाकशुदा', abandoned: 'परित्यक्ता', married: 'विवाहित', unmarried: 'अविवाहित',
    general: 'सामान्य', sc: 'अनुसूचित जाति', st: 'अनुसूचित जनजाति', obc: 'ओबीसी', ews: 'ईडब्ल्यूएस',
    dwarfism: 'बौनापन', farmer: 'किसान', labourer: 'मजदूर', student: 'विद्यार्थी', unemployed: 'बेरोजगार',
    government: 'सरकारी अस्पताल', jsy_empaneled_private: 'JSY-पंजीकृत निजी अस्पताल', graduate: 'स्नातक',
    nfsa: 'NFSA सूची में', secc_2011: 'SECC 2011 सूची में', small_marginal_farmer: 'लघु/सीमांत कृषक',
    contract_worker: 'संविदा कर्मी', covid_exgratia_recipient: 'कोविड-19 अनुग्रह राशि प्राप्तकर्ता',
    other: 'इनमें से कोई नहीं',
  };

  function questionFor(slot) { return SLOT_QUESTIONS_HI[slot] || (slot + '?'); }
  function labelFor(value) {
    var key = String(value);
    return Object.prototype.hasOwnProperty.call(VALUE_LABELS_HI, key) ? VALUE_LABELS_HI[key] : key;
  }

  var RANGE_OPS = { lte: true, gte: true, between: true };
  var ENUM_OPS = { eq: true, in: true };

  function collectSlotConditions(scheme, slot) {
    var out = [];
    var elig = scheme.eligibility || {};
    ['all_of', 'any_of', 'none_of'].forEach(function (group) {
      (elig[group] || []).forEach(function (entry) {
        var conditions = Array.isArray(entry) ? entry : [entry];
        conditions.forEach(function (c) { if (c.slot === slot) out.push(c); });
      });
    });
    return out;
  }

  // Derives what to ask purely from this one scheme's own condition
  // literals — no slots.json catalogue available here. eq/in conditions
  // become tappable options (values named literally in the condition, or
  // हाँ/नहीं if every value found is boolean); lte/gte/between become a
  // number input, or a date input when the compared value looks like an
  // ISO date.
  function buildQuestionSpec(scheme, slot) {
    var conditions = collectSlotConditions(scheme, slot);
    var values = [];
    var seen = {};
    conditions.forEach(function (c) {
      if (!ENUM_OPS[c.op]) return;
      var vs = Array.isArray(c.value) ? c.value : [c.value];
      vs.forEach(function (v) {
        if (v === '*') return;
        var key = String(v);
        if (!seen[key]) { seen[key] = true; values.push(v); }
      });
    });

    if (values.length > 0) {
      var allBoolean = values.every(function (v) { return typeof v === 'boolean'; });
      if (allBoolean) return { type: 'boolean' };
      return { type: 'enum', options: values };
    }

    var rangeCondition = conditions.filter(function (c) { return RANGE_OPS[c.op]; })[0];
    if (rangeCondition) {
      var sample = rangeCondition.value;
      var isDate = typeof sample === 'string' && /^\d{4}-\d{2}-\d{2}/.test(sample);
      return { type: isDate ? 'date' : 'number' };
    }

    return { type: 'number' };
  }

  var WIDGET_CSS =
    ':host, .vaani-embed { all: initial; }\n' +
    '.vaani-embed {\n' +
    "  font-family: 'Noto Sans Devanagari', 'Inter', sans-serif;\n" +
    '  display: block;\n' +
    '  max-width: 420px;\n' +
    '  color: #14181F;\n' +
    '  background: #F6F2E9;\n' +
    '  border: 1px solid rgba(20,24,31,0.15);\n' +
    '  border-radius: 12px;\n' +
    '  padding: 1rem;\n' +
    '  box-sizing: border-box;\n' +
    '  line-height: 1.5;\n' +
    '  font-size: 15px;\n' +
    '}\n' +
    '.vaani-embed * { box-sizing: border-box; }\n' +
    '.vaani-embed__badge {\n' +
    '  display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: 0.03em;\n' +
    '  color: #1B3A6B; opacity: 0.7; text-transform: uppercase; margin-bottom: 0.5rem;\n' +
    '}\n' +
    '.vaani-embed__heading { font-size: 17px; font-weight: 700; color: #1B3A6B; margin: 0 0 0.6rem; }\n' +
    '.vaani-embed__text { margin: 0 0 0.75rem; }\n' +
    '.vaani-embed__options { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.5rem; }\n' +
    '.vaani-embed__btn {\n' +
    '  min-height: 40px; padding: 0.5rem 0.9rem; border-radius: 999px; border: 2px solid #1B3A6B;\n' +
    "  background: #F6F2E9; color: #1B3A6B; font: inherit; font-size: 14px; font-weight: 600; cursor: pointer;\n" +
    '}\n' +
    '.vaani-embed__btn:hover { background: #1B3A6B; color: #F6F2E9; }\n' +
    '.vaani-embed__btn--muted { opacity: 0.7; font-weight: 500; }\n' +
    '.vaani-embed__input {\n' +
    '  min-height: 40px; padding: 0.5rem 0.75rem; border-radius: 8px; border: 2px solid #1B3A6B;\n' +
    '  font: inherit; font-size: 14px; width: 100%; margin-bottom: 0.5rem; background: #fff; color: #14181F;\n' +
    '}\n' +
    '.vaani-embed__verdict { font-size: 16px; font-weight: 700; margin-bottom: 0.4rem; }\n' +
    '.vaani-embed__verdict--eligible { color: #1B7F4B; }\n' +
    '.vaani-embed__verdict--not-eligible { color: #B03A2E; }\n' +
    '.vaani-embed__docs { margin: 0.6rem 0; padding: 0; list-style: none; }\n' +
    '.vaani-embed__docs li { padding: 0.3rem 0; border-bottom: 1px solid rgba(20,24,31,0.08); font-size: 14px; }\n' +
    '.vaani-embed__citation { font-size: 12px; opacity: 0.75; margin-top: 0.6rem; word-break: break-word; }\n' +
    '.vaani-embed__citation a { color: #1B3A6B; }\n' +
    '.vaani-embed__fallback-link {\n' +
    '  display: inline-block; font-weight: 700; color: #1B3A6B; text-decoration: underline;\n' +
    '}\n' +
    '.vaani-embed__footer { margin-top: 0.75rem; font-size: 11px; opacity: 0.6; }\n' +
    '@font-face { font-family: "Noto Sans Devanagari"; src: url("' + FONT_HI_URL + '") format("truetype-variations"); font-weight: 400 900; font-display: swap; }\n' +
    '@font-face { font-family: "Inter"; src: url("' + FONT_LATIN_URL + '") format("truetype-variations"); font-weight: 100 900; font-display: swap; }\n';

  function createWidgetRoot() {
    var host = document.createElement('div');
    var shadow = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = WIDGET_CSS;
    var root = document.createElement('div');
    root.className = 'vaani-embed';
    root.setAttribute('role', 'region');
    root.setAttribute('aria-live', 'polite');
    shadow.appendChild(style);
    shadow.appendChild(root);
    if (scriptEl && scriptEl.parentNode) {
      scriptEl.parentNode.insertBefore(host, scriptEl.nextSibling);
    } else {
      document.body.appendChild(host);
    }
    return root;
  }

  function renderFallbackLink(root, message) {
    root.innerHTML = '';
    var p = document.createElement('p');
    p.className = 'vaani-embed__text';
    p.textContent = message;
    var a = document.createElement('a');
    a.className = 'vaani-embed__fallback-link';
    a.href = APP_URL;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'VAANI पर योजना जानकारी देखें →';
    root.appendChild(p);
    root.appendChild(a);
  }

  function renderLoading(root) {
    root.innerHTML = '';
    var p = document.createElement('p');
    p.className = 'vaani-embed__text';
    p.textContent = 'लोड हो रहा है...';
    root.appendChild(p);
  }

  function buildDocList(documents) {
    var ul = document.createElement('ul');
    ul.className = 'vaani-embed__docs';
    (documents || []).forEach(function (doc) {
      var li = document.createElement('li');
      li.textContent = doc.label_hi + (doc.where_to_get_hi ? ' — ' + doc.where_to_get_hi : '');
      ul.appendChild(li);
    });
    return ul;
  }

  function buildCitation(citation) {
    var p = document.createElement('p');
    p.className = 'vaani-embed__citation';
    if (!citation) return p;
    p.appendChild(document.createTextNode('स्रोत: '));
    var a = document.createElement('a');
    a.href = citation.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = citation.url;
    p.appendChild(a);
    if (citation.last_verified) {
      p.appendChild(document.createTextNode(' · ' + citation.last_verified));
    }
    return p;
  }

  function renderQuestion(root, scheme, slot, onAnswer) {
    root.innerHTML = '';
    var badge = document.createElement('div');
    badge.className = 'vaani-embed__badge';
    badge.textContent = 'VAANI — योजना पात्रता जांच';
    var heading = document.createElement('p');
    heading.className = 'vaani-embed__heading';
    heading.textContent = scheme.name_hi;
    var question = document.createElement('p');
    question.className = 'vaani-embed__text';
    question.textContent = questionFor(slot);
    root.appendChild(badge);
    root.appendChild(heading);
    root.appendChild(question);

    var spec = buildQuestionSpec(scheme, slot);

    if (spec.type === 'boolean') {
      var wrap = document.createElement('div');
      wrap.className = 'vaani-embed__options';
      [[true, 'हाँ'], [false, 'नहीं']].forEach(function (pair) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'vaani-embed__btn';
        btn.textContent = pair[1];
        btn.addEventListener('click', function () { onAnswer(pair[0]); });
        wrap.appendChild(btn);
      });
      root.appendChild(wrap);
    } else if (spec.type === 'enum') {
      var wrap2 = document.createElement('div');
      wrap2.className = 'vaani-embed__options';
      spec.options.forEach(function (value) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'vaani-embed__btn';
        btn.textContent = labelFor(value);
        btn.addEventListener('click', function () { onAnswer(value); });
        wrap2.appendChild(btn);
      });
      root.appendChild(wrap2);
    } else {
      var input = document.createElement('input');
      input.className = 'vaani-embed__input';
      input.type = spec.type === 'date' ? 'date' : 'number';
      root.appendChild(input);
      var okBtn = document.createElement('button');
      okBtn.type = 'button';
      okBtn.className = 'vaani-embed__btn';
      okBtn.textContent = 'ठीक है';
      okBtn.addEventListener('click', function () {
        if (input.value === '') return;
        onAnswer(spec.type === 'date' ? input.value : Number(input.value));
      });
      var optsWrap = document.createElement('div');
      optsWrap.className = 'vaani-embed__options';
      optsWrap.appendChild(okBtn);
      root.appendChild(optsWrap);
    }

    var dontKnowBtn = document.createElement('button');
    dontKnowBtn.type = 'button';
    dontKnowBtn.className = 'vaani-embed__btn vaani-embed__btn--muted';
    dontKnowBtn.textContent = 'पता नहीं';
    dontKnowBtn.addEventListener('click', function () { onAnswer(undefined); });
    root.appendChild(dontKnowBtn);
  }

  function renderVerdict(root, scheme, verdict, assembled) {
    root.innerHTML = '';
    var badge = document.createElement('div');
    badge.className = 'vaani-embed__badge';
    badge.textContent = 'VAANI — योजना पात्रता जांच';
    var verdictLine = document.createElement('p');
    verdictLine.className = 'vaani-embed__verdict ' +
      (verdict === 'ELIGIBLE' ? 'vaani-embed__verdict--eligible' : 'vaani-embed__verdict--not-eligible');
    verdictLine.textContent = verdict === 'ELIGIBLE' ? '✓ आप पात्र लग रहे हैं' : '✕ आप शायद पात्र नहीं हैं';
    var text = document.createElement('p');
    text.className = 'vaani-embed__text';
    text.textContent = assembled.text_hi;
    root.appendChild(badge);
    root.appendChild(verdictLine);
    root.appendChild(text);
    if (assembled.documents && assembled.documents.length > 0) {
      root.appendChild(buildDocList(assembled.documents));
    }
    root.appendChild(buildCitation(assembled.citation));
    var footer = document.createElement('p');
    footer.className = 'vaani-embed__footer';
    footer.textContent = 'यह एक स्वचालित प्रारंभिक जांच है, अंतिम निर्णय नहीं — नज़दीकी ई-मित्र पर पुष्टि करें।';
    root.appendChild(footer);
  }

  function init() {
    var root = createWidgetRoot();
    renderLoading(root);

    fetch(SCHEME_URL)
      .then(function (resp) {
        if (!resp.ok) throw new Error('scheme fetch failed: ' + resp.status);
        return resp.json();
      })
      .then(function (scheme) {
        return Promise.all([
          scheme,
          import(/* webpackIgnore: true */ ELIGIBILITY_URL),
          import(/* webpackIgnore: true */ ASSEMBLE_URL),
        ]);
      })
      .then(function (results) {
        var scheme = results[0];
        var eligibilityMod = results[1];
        var assembleMod = results[2];
        var slots = {};

        function step() {
          var evaluation = eligibilityMod.evaluate(slots, scheme);
          if (evaluation.verdict === 'NEED_MORE_INFO') {
            var slot = evaluation.missing_slots[0];
            if (!slot) {
              // Shouldn't happen (NEED_MORE_INFO implies a missing slot),
              // but never leave the widget stuck with no next action.
              renderFallbackLink(root, 'जानकारी अधूरी — VAANI पर पूरी जांच करें।');
              return;
            }
            renderQuestion(root, scheme, slot, function (answer) {
              if (answer !== undefined) slots[slot] = answer;
              step();
            });
            return;
          }
          var assembled = assembleMod.assemble(evaluation.verdict, scheme, evaluation);
          if (!assembled.citation) {
            renderFallbackLink(root, 'इस योजना की जानकारी अभी उपलब्ध नहीं — VAANI पर देखें।');
            return;
          }
          renderVerdict(root, scheme, evaluation.verdict, assembled);
        }

        step();
      })
      .catch(function () {
        renderFallbackLink(root, 'जानकारी अभी लोड नहीं हो सकी।');
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
