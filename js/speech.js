// Pure speech adapter — ASR in, TTS out. No normalisation, no routing, no
// eligibility, no rendering. Swappable per 01_SOLUTION_SPEC.md §3: this is
// the Web Speech API implementation; a Bhashini/IndicConformer adapter
// would expose the same listen()/speak() shape.

const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;

let activeRecognition = null;

export function isRecognitionSupported() {
  return !!SpeechRecognitionImpl;
}

function describeError(reason) {
  switch (reason) {
    case 'permission-denied':
      return 'माइक की अनुमति नहीं मिली';
    case 'no-speech':
      return 'कोई आवाज़ सुनाई नहीं दी';
    case 'unsupported':
      return 'इस ब्राउज़र में माइक सुविधा उपलब्ध नहीं है';
    default:
      return 'माइक में समस्या आई';
  }
}

// Real mobile Chrome can silently end a recognition session — especially a
// second-or-later one in the same page — without ever firing onresult or
// onerror. Without a backstop, the mic button pulses forever with no way
// out. LISTEN_TIMEOUT_MS is the hard ceiling; onend below usually catches
// it sooner.
const LISTEN_TIMEOUT_MS = 10000;

// ===== S2: start/stop beeps — WebAudio oscillator, no asset file, so a
// citizen who can't read the screen still knows exactly when to speak and
// when the app stopped listening. A quiet gain envelope with an
// exponential ramp-down avoids the audible "click" a hard oscillator.stop
// would otherwise produce.
const BEEP_DURATION_S = 0.18;
const LISTEN_START_BEEP_HZ = 880;
const LISTEN_STOP_BEEP_HZ = 440; // one octave down — audibly distinct "done" cue

function playBeep(frequencyHz) {
  const AudioContextImpl = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextImpl) return;
  try {
    const ctx = new AudioContextImpl();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.frequency.value = frequencyHz;
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + BEEP_DURATION_S);
    oscillator.start();
    oscillator.stop(ctx.currentTime + BEEP_DURATION_S);
    oscillator.addEventListener('ended', () => ctx.close());
  } catch (_) {
    // WebAudio unavailable/blocked — the beep is a nicety, not required.
  }
}

// S2: any mic tap must be able to interrupt a long spoken answer, not
// queue behind it.
export function cancelSpeech() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}

// onResult({ transcript, isFinal, confidence }) fires for every interim and
// final result. onError({ type, message }) fires at most once per call and
// the caller must fall back to typed/tapped input — never a dead end.
export function listen(onResult, onError) {
  if (!SpeechRecognitionImpl) {
    onError({ type: 'unsupported', message: describeError('unsupported') });
    return null;
  }

  const recognition = new SpeechRecognitionImpl();
  recognition.lang = 'hi-IN';
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;

  let settled = false;
  let timeoutHandle = null;

  function clearTimeoutGuard() {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
  }

  function fail(reason) {
    if (settled) return;
    settled = true;
    clearTimeoutGuard();
    playBeep(LISTEN_STOP_BEEP_HZ);
    onError({ type: reason, message: describeError(reason) });
  }

  recognition.onresult = (event) => {
    let finalTranscript = '';
    let interimTranscript = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) finalTranscript += result[0].transcript;
      else interimTranscript += result[0].transcript;
    }
    const latest = event.results[event.results.length - 1][0];
    const isFinal = finalTranscript.length > 0;
    if (isFinal) {
      settled = true;
      clearTimeoutGuard();
      playBeep(LISTEN_STOP_BEEP_HZ);
    }
    onResult({
      transcript: finalTranscript || interimTranscript,
      isFinal,
      confidence: typeof latest.confidence === 'number' ? latest.confidence : null,
    });
  };

  recognition.onerror = (event) => {
    const reason = event.error === 'not-allowed' || event.error === 'permission-denied'
      ? 'permission-denied'
      : event.error === 'no-speech'
        ? 'no-speech'
        : 'unknown';
    fail(reason);
  };

  // Safety net: the browser gave up (e.g. prolonged silence) without ever
  // calling onresult or onerror.
  recognition.onend = () => fail('no-speech');

  try {
    playBeep(LISTEN_START_BEEP_HZ);
    recognition.start();
  } catch (err) {
    onError({ type: 'start-failed', message: describeError('unknown') });
    return null;
  }

  // Safety net: the browser never ended the session at all.
  timeoutHandle = setTimeout(() => {
    if (settled) return;
    settled = true;
    try {
      recognition.abort();
    } catch (_) {
      // already gone
    }
    onError({ type: 'timeout', message: 'माइक ने ज़्यादा समय ले लिया — दोबारा कोशिश करें' });
  }, LISTEN_TIMEOUT_MS);

  activeRecognition = recognition;
  return recognition;
}

export function stopListening() {
  if (activeRecognition) {
    activeRecognition.stop();
    activeRecognition = null;
  }
}

// ===== S1: TTS voice hardening =====
// Every response this app speaks is Devanagari. Feeding Devanagari to a
// non-Indic voice (e.g. a US-English engine) produces unintelligible
// output — worse than staying silent, since a low-literacy listener has
// no text fallback for garbled audio. So selection is two separate
// decisions: which voice is "best available" (used for utterance.voice
// and shown in the disclosure panel), and whether that voice is actually
// Hindi-capable (gates whether speak() is allowed to say anything at all).
function pickVoice(voices) {
  const exactHindi = voices.find((v) => v.lang === 'hi-IN');
  const anyHindi = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith('hi'));
  const indianEnglish = voices.find((v) => v.lang && v.lang.toLowerCase() === 'en-in');
  const defaultVoice = voices.find((v) => v.default) || voices[0] || null;
  return {
    voice: exactHindi || anyHindi || indianEnglish || defaultVoice,
    hindiCapable: !!(exactHindi || anyHindi),
  };
}

// Pessimistic until proven otherwise — never speak before we've actually
// confirmed a Hindi-capable voice exists, matching this project's "never
// guess" discipline.
let selectedVoice = null;
let ttsDegraded = true;
const ttsStateListeners = [];

function currentTtsState() {
  return {
    ttsDegraded,
    voiceName: selectedVoice ? selectedVoice.name : null,
    voiceLang: selectedVoice ? selectedVoice.lang : null,
  };
}

function notifyTtsStateListeners() {
  const state = currentTtsState();
  ttsStateListeners.forEach((cb) => cb(state));
}

function applyVoiceSelection() {
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return; // Chrome returns [] on first call; voiceschanged will fire.
  const { voice, hindiCapable } = pickVoice(voices);
  selectedVoice = voice;
  ttsDegraded = !hindiCapable;
  notifyTtsStateListeners();
}

// Call once at app init. onStateChange(state) fires immediately with the
// current (possibly still-degraded) state, and again whenever the voice
// list resolves or changes — Chrome in particular loads voices
// asynchronously, sometimes after a delay, so a one-shot check at load
// time is not reliable.
export function initTts(onStateChange) {
  if (onStateChange) ttsStateListeners.push(onStateChange);
  if (!('speechSynthesis' in window)) {
    selectedVoice = null;
    ttsDegraded = true;
    notifyTtsStateListeners();
    return;
  }
  applyVoiceSelection();
  notifyTtsStateListeners(); // fire immediately even if still pessimistic/empty
  window.speechSynthesis.addEventListener('voiceschanged', applyVoiceSelection);
}

export function isTtsDegraded() {
  return ttsDegraded;
}

export function getTtsVoiceInfo() {
  return currentTtsState();
}

// Rate 0.85: the platform default (1.0) is too fast for elderly listeners.
// Refuses to speak at all when degraded — see the module comment above.
export function speak(text) {
  if (!('speechSynthesis' in window) || !text) return;
  if (ttsDegraded) return;
  const utterance = new SpeechSynthesisUtterance(text);
  if (selectedVoice) {
    utterance.voice = selectedVoice;
    utterance.lang = selectedVoice.lang;
  } else {
    utterance.lang = 'hi-IN';
  }
  utterance.rate = 0.85;
  utterance.pitch = 1.0;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}
