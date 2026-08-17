// PRODUCTION NOTE: this is a client-side simulator of the Jan Aadhaar API
// per Integration Document v1.8. It never calls the real endpoints — we
// hold no appCode and our IP is not whitelisted. Every envelope on screen
// is genuine (real WebCrypto AES-256-CBC + RSA-OAEP, real throwaway
// keypairs generated in-browser) but the "server" it talks to is this
// same module. See SIMULATED_BANNER_TEXT below for the required disclosure.

export const SIMULATED_BANNER_TEXT =
  'SIMULATED — implements Jan Aadhaar Integration Doc v1.8. No real citizen data. ' +
  'Live integration requires DoIT&C-issued appCode and schemeCode plus server IP whitelisting.';

const ERROR_MESSAGES_HI = {
  JAN_002: 'योजना ऑनबोर्ड नहीं है (scheme not onboarded)',
  JAN_003: 'IP व्हाइटलिस्ट नहीं है (IP not whitelisted)',
  JAN_005: 'जन आधार ID आवश्यक है (Jan Aadhaar ID mandatory)',
  JAN_101: 'आधार eKYC विफल (Aadhaar eKYC failed)',
  JAN_102: 'उपयोगकर्ता ने OTP के बाद eKYC छोड़ दिया (user terminated eKYC after OTP)',
  JAN_404: 'कोई डेटा नहीं मिला (no data found)',
  JAN_501: 'डुप्लिकेट ट्रांजेक्शन ID (duplicate transaction ID)',
};

// ===== Mock data — clearly fake, never persisted =====
const MOCK_FAMILIES = {
  'JANID-DEMO-0001': [
    { memberId: 'MEM-1001', nameLl: 'रवि शर्मा', nameEn: 'Ravi Sharma', dob: '1965-03-14', gender: 'MALE' },
    { memberId: 'MEM-1002', nameLl: 'सुनीता शर्मा', nameEn: 'Sunita Sharma', dob: '1968-07-22', gender: 'FEMALE' },
    { memberId: 'MEM-1003', nameLl: 'अनुज शर्मा', nameEn: 'Anuj Sharma', dob: '1999-11-02', gender: 'MALE' },
  ],
  'JANID-DEMO-0002': [
    { memberId: 'MEM-2001', nameLl: 'गीता मीणा', nameEn: 'Geeta Meena', dob: '1958-01-30', gender: 'FEMALE' },
    { memberId: 'MEM-2002', nameLl: 'कमल मीणा', nameEn: 'Kamal Meena', dob: '1954-09-09', gender: 'MALE' },
  ],
};

// Illustrative only — the real spec's validateOtp response includes
// "onboarding-selected fields" that vary per department; these are not
// documented field names, just a plausible example for the demo.
const MOCK_ONBOARDING_FIELDS = {
  'MEM-1001': { annual_income: 95000, category: 'general', district: 'जयपुर' },
  'MEM-1002': { annual_income: 95000, category: 'general', district: 'जयपुर' },
  'MEM-1003': { annual_income: 95000, category: 'general', district: 'जयपुर' },
  'MEM-2001': { annual_income: 42000, category: 'st', district: 'उदयपुर' },
  'MEM-2002': { annual_income: 42000, category: 'st', district: 'उदयपुर' },
};

// Documented masking rule: keep odd character positions (1st, 3rd, ...),
// mask even positions — reproduces the spec's own example exactly:
// maskName('Amit Kumar') === 'A*i* K*m*r'.
function maskName(name) {
  return name
    .split(' ')
    .map((word) => word.split('').map((ch, i) => (i % 2 === 0 ? ch : '*')).join(''))
    .join(' ');
}

// ===== WebCrypto helpers =====
function bufToBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function base64ToBuf(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
}

async function generateSigningKeyPair() {
  return crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
}

async function generateEncryptionKeyPair() {
  return crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt']
  );
}

// Throwaway keypairs, generated once per page session, held only in
// memory. WebCrypto keys are algorithm-bound (a signing key can't be used
// for encrypt/decrypt and vice versa), so signing and encryption each need
// their own keypair on both simulated sides:
//   clientSigning       — we sign our own requests with this.
//   clientEncryption     — Jan Aadhaar encrypts responses TO us with this
//                          public half (we hold the private half to read them).
//   janAadhaarSigning    — stands in for Jan Aadhaar's signing key; it signs
//                          the simulated responses.
//   janAadhaarEncryption — stands in for Jan Aadhaar's published public
//                          encryption key; we encrypt requests to it. We
//                          only hold its private half here because we're
//                          simulating BOTH sides locally — a real
//                          integration never would.
let keysReady = null;
function ensureKeys() {
  if (!keysReady) {
    keysReady = Promise.all([
      generateSigningKeyPair(),
      generateEncryptionKeyPair(),
      generateSigningKeyPair(),
      generateEncryptionKeyPair(),
    ]).then(([clientSigning, clientEncryption, janAadhaarSigning, janAadhaarEncryption]) => ({
      clientSigning,
      clientEncryption,
      janAadhaarSigning,
      janAadhaarEncryption,
    }));
  }
  return keysReady;
}

async function certFingerprint(publicKey) {
  const spki = await crypto.subtle.exportKey('spki', publicKey);
  const hash = await crypto.subtle.digest('SHA-256', spki);
  return bufToBase64(hash);
}

// Sign -> AES-256-CBC encrypt -> RSA-OAEP encrypt the AES key -> wrap as
// "iv:data:key", per the transport envelope documented in the Integration
// Doc. WebCrypto's AES-CBC applies PKCS7 padding, the practical equivalent
// of the doc's "PKCS5" for 16-byte blocks.
async function buildEnvelope(payloadObj, signingPrivateKey, recipientPublicKey) {
  const payloadJson = JSON.stringify(payloadObj);
  const signature = bufToBase64(
    await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, signingPrivateKey, new TextEncoder().encode(payloadJson))
  );
  const signedPayload = JSON.stringify({ ...payloadObj, signature });

  const aesKey = await crypto.subtle.generateKey({ name: 'AES-CBC', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv },
    aesKey,
    new TextEncoder().encode(signedPayload)
  );
  const rawAesKey = await crypto.subtle.exportKey('raw', aesKey);
  const encryptedAesKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, recipientPublicKey, rawAesKey);

  const ivB64 = bufToBase64(iv);
  const dataB64 = bufToBase64(encrypted);
  const keyB64 = bufToBase64(encryptedAesKey);

  return {
    transport: `${ivB64}:${dataB64}:${keyB64}`,
    decryptedPayload: JSON.parse(signedPayload),
  };
}

async function openEnvelope(transportString, recipientPrivateKey) {
  const [ivB64, dataB64, keyB64] = transportString.split(':');
  const rawAesKey = await crypto.subtle.decrypt(
    { name: 'RSA-OAEP' },
    recipientPrivateKey,
    base64ToBuf(keyB64)
  );
  const aesKey = await crypto.subtle.importKey('raw', rawAesKey, { name: 'AES-CBC' }, false, ['decrypt']);
  const decryptedBuf = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: new Uint8Array(base64ToBuf(ivB64)) },
    aesKey,
    base64ToBuf(dataB64)
  );
  return JSON.parse(new TextDecoder().decode(decryptedBuf));
}

// ===== Forced error codes (for the "force an error" UI control) =====
let forcedErrorCode = null;
export function setForcedErrorCode(code) {
  forcedErrorCode = code || null;
}
export function getForcedErrorCode() {
  return forcedErrorCode;
}

const DOCUMENTED_RESPONSE_CODES = ['JAN_000', 'JAN_002', 'JAN_003', 'JAN_005', 'JAN_101', 'JAN_102', 'JAN_404', 'JAN_501'];
export { DOCUMENTED_RESPONSE_CODES };

// ===== Envelope-building request/response wrapper shared by all 3 calls =====
// autoErrorCode lets a caller signal a naturally-occurring error (e.g. an
// unknown Jan Aadhaar ID really is a JAN_404) that's decided BEFORE the
// envelope is built, so the encrypted payload and the reported
// responseCode never disagree. The UI's forced-error dropdown always wins
// over an auto-detected code, since that's a deliberate test choice.
async function performCall(params, buildSuccessPayload, autoErrorCode) {
  const keys = await ensureKeys();
  const fingerprint = await certFingerprint(keys.clientSigning.publicKey);

  const requestEnvelope = await buildEnvelope(params, keys.clientSigning.privateKey, keys.janAadhaarEncryption.publicKey);

  const responseCode = forcedErrorCode || autoErrorCode || 'JAN_000';
  const responsePayload = responseCode === 'JAN_000'
    ? { responseCode, ...buildSuccessPayload() }
    : { responseCode, message_hi: ERROR_MESSAGES_HI[responseCode] || responseCode };

  // "Server" (janAadhaarSigning holds the simulated government signing key)
  // signs+encrypts its response addressed to our clientEncryption public key.
  const responseEnvelope = await buildEnvelope(
    responsePayload,
    keys.janAadhaarSigning.privateKey,
    keys.clientEncryption.publicKey
  );
  // Prove the round trip is genuine by actually decrypting what we built.
  const decryptedResponse = await openEnvelope(responseEnvelope.transport, keys.clientEncryption.privateKey);

  return {
    request: {
      params,
      headers: { 'X-Cert-Fingerprint': fingerprint },
      envelope: requestEnvelope.transport,
      decryptedPayload: requestEnvelope.decryptedPayload,
    },
    response: {
      envelope: responseEnvelope.transport,
      decryptedPayload: decryptedResponse,
      responseCode,
    },
  };
}

// ===== The three documented endpoints =====
export async function memberList({ appCode, schemShortCode, transactionId, janId }) {
  const members = MOCK_FAMILIES[janId];
  // An unknown Jan Aadhaar ID is itself a real JAN_404, not a forced test.
  const autoErrorCode = members ? null : 'JAN_404';
  return performCall(
    { appCode, schemShortCode, transactionId, janId },
    () => ({ members: members.map((m) => ({ MEMBERID: m.memberId, NAME_MASKED: maskName(m.nameEn) })) }),
    autoErrorCode
  );
}

export async function generateOtp({ appCode, schemShortCode, transactionId, memberId }) {
  const tid = `TID-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36).toUpperCase()}`;
  // Demo convenience: the simulator displays the OTP it "sent" since there
  // is no real SMS channel here — never a real citizen's actual OTP.
  const demoOtp = String(100000 + Math.floor(Math.random() * 900000));
  return performCall({ appCode, schemShortCode, transactionId, memberId }, () => ({ tid, demo_otp_hi: demoOtp }));
}

export async function validateOtp({ appCode, schemShortCode, transactionId, memberId, tid, otp }) {
  const allMembers = Object.values(MOCK_FAMILIES).flat();
  const member = allMembers.find((m) => m.memberId === memberId);
  const autoErrorCode = member ? null : 'JAN_404';
  return performCall(
    { appCode, schemShortCode, transactionId, memberId, tid, otp },
    () => ({
      NAME_LL: member.nameLl,
      NAME_EN: member.nameEn,
      DOB: member.dob,
      GENDER: member.gender,
      ...(MOCK_ONBOARDING_FIELDS[memberId] || {}),
    }),
    autoErrorCode
  );
}

// ===== UI panel =====
// context: { onAutofill(slots) } — called with { gender, age, annual_income,
// category, district } when the operator/citizen chooses to accept a
// validated member's data. This module owns its own DOM only; app.js
// decides what to do with the autofilled slots.
export function initJanAadhaar(context) {
  const trigger = document.getElementById('janaadhaar-trigger');
  const modal = document.getElementById('janaadhaar-modal');
  const closeBtn = document.getElementById('janaadhaar-close');
  if (!trigger || !modal) return;

  // B4: the one source of truth for this disclosure — index.html no longer
  // carries its own copy that could drift out of sync with this one.
  const banner = document.getElementById('janaadhaar-banner');
  if (banner) banner.textContent = SIMULATED_BANNER_TEXT;

  let state = { members: [], selectedMemberId: null, tid: null, appCode: 'DEMO_APP_CODE', schemShortCode: 'VAANI_DEMO' };

  function newTransactionId() {
    return `TXN-${Date.now()}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
  }

  // B3: builds a <p><strong>label</strong></p><pre>content</pre> pair with
  // textContent throughout — content here traces back to operator-typed
  // input (janId, otp) by way of `result`, so it must never be interpreted
  // as markup.
  function buildLabeledPre(labelText, content) {
    const frag = document.createDocumentFragment();
    const label = document.createElement('p');
    const strong = document.createElement('strong');
    strong.textContent = labelText;
    label.appendChild(strong);
    const pre = document.createElement('pre');
    pre.textContent = content;
    frag.append(label, pre);
    return frag;
  }

  function logEnvelope(stepName, result) {
    const log = document.getElementById('janaadhaar-log');
    const block = document.createElement('div');
    block.className = 'janaadhaar-log-entry';

    const heading = document.createElement('h4');
    heading.textContent = `${stepName} — responseCode: ${result.response.responseCode}`;
    block.appendChild(heading);

    const fingerprintP = document.createElement('p');
    const fingerprintLabel = document.createElement('strong');
    fingerprintLabel.textContent = 'X-Cert-Fingerprint:';
    const fingerprintCode = document.createElement('code');
    fingerprintCode.textContent = `${result.request.headers['X-Cert-Fingerprint'].slice(0, 32)}…`;
    fingerprintP.append(fingerprintLabel, ' ', fingerprintCode);
    block.appendChild(fingerprintP);

    block.appendChild(buildLabeledPre('Request envelope', result.request.envelope));
    block.appendChild(buildLabeledPre('Response envelope', result.response.envelope));
    block.appendChild(buildLabeledPre('Decrypted response payload', JSON.stringify(result.response.decryptedPayload, null, 2)));

    log.prepend(block);
  }

  function showError(result) {
    const errorEl = document.getElementById('janaadhaar-error');
    if (result.response.responseCode === 'JAN_000') {
      errorEl.hidden = true;
      return false;
    }
    errorEl.hidden = false;
    errorEl.innerHTML = '';

    const codeP = document.createElement('p');
    const codeStrong = document.createElement('strong');
    codeStrong.textContent = `${result.response.responseCode}:`;
    codeP.append(codeStrong, ` ${ERROR_MESSAGES_HI[result.response.responseCode] || ''}`);
    errorEl.appendChild(codeP);

    const fallbackP = document.createElement('p');
    fallbackP.textContent = 'स्वचालित सत्यापन विफल — कृपया जानकारी मैन्युअल रूप से भरें।';
    errorEl.appendChild(fallbackP);

    const fallbackBtn = document.createElement('button');
    fallbackBtn.type = 'button';
    fallbackBtn.id = 'janaadhaar-manual-fallback';
    fallbackBtn.className = 'chip-btn';
    fallbackBtn.textContent = 'मैन्युअल रूप से जारी रखें';
    fallbackBtn.addEventListener('click', () => closeModal());
    errorEl.appendChild(fallbackBtn);
    return true;
  }

  function resetSteps() {
    document.getElementById('janaadhaar-step2').hidden = true;
    document.getElementById('janaadhaar-step3').hidden = true;
    document.getElementById('janaadhaar-result').hidden = true;
    document.getElementById('janaadhaar-error').hidden = true;
    document.getElementById('janaadhaar-members').innerHTML = '';
  }

  function openModal() {
    modal.hidden = false;
    resetSteps();
    document.getElementById('janaadhaar-log').innerHTML = '';
    document.getElementById('janaadhaar-jan-id').value = 'JANID-DEMO-0001';
  }

  function closeModal() {
    modal.hidden = true;
  }

  // P5: built from DOCUMENTED_RESPONSE_CODES instead of a hand-listed
  // <option> per code in index.html, so the dropdown can't fall out of
  // sync with what this module actually documents. JAN_000 (no forced
  // error) maps to value="" — forcing the literal code would be a no-op
  // identical to not forcing anything, since JAN_000 is the success path.
  function populateErrorSelect() {
    const select = document.getElementById('janaadhaar-error-select');
    select.innerHTML = '';
    DOCUMENTED_RESPONSE_CODES.forEach((code) => {
      const option = document.createElement('option');
      if (code === 'JAN_000') {
        option.value = '';
        option.textContent = 'कोई नहीं — सामान्य प्रवाह (JAN_000)';
      } else {
        option.value = code;
        option.textContent = `${code} — ${ERROR_MESSAGES_HI[code] || code}`;
      }
      select.appendChild(option);
    });
  }
  populateErrorSelect();

  trigger.addEventListener('click', openModal);
  closeBtn.addEventListener('click', closeModal);

  document.getElementById('janaadhaar-error-select').addEventListener('change', (e) => {
    setForcedErrorCode(e.target.value);
  });

  document.getElementById('janaadhaar-fetch-btn').addEventListener('click', async () => {
    resetSteps();
    const janId = document.getElementById('janaadhaar-jan-id').value.trim();
    const transactionId = newTransactionId();
    const result = await memberList({ appCode: state.appCode, schemShortCode: state.schemShortCode, transactionId, janId });
    logEnvelope('1. सदस्य सूची / member-list', result);
    if (showError(result)) return;

    state.members = result.response.decryptedPayload.members || [];
    const list = document.getElementById('janaadhaar-members');
    state.members.forEach((m) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip-btn';
      btn.textContent = `${m.NAME_MASKED} (${m.MEMBERID})`;
      btn.addEventListener('click', () => {
        state.selectedMemberId = m.MEMBERID;
        document.getElementById('janaadhaar-step2').hidden = false;
      });
      list.appendChild(btn);
    });
  });

  document.getElementById('janaadhaar-otp-btn').addEventListener('click', async () => {
    const transactionId = newTransactionId();
    const result = await generateOtp({
      appCode: state.appCode,
      schemShortCode: state.schemShortCode,
      transactionId,
      memberId: state.selectedMemberId,
    });
    logEnvelope('2. OTP जनरेट / generate-otp', result);
    if (showError(result)) return;

    state.tid = result.response.decryptedPayload.tid;
    document.getElementById('janaadhaar-demo-otp').textContent = result.response.decryptedPayload.demo_otp_hi;
    document.getElementById('janaadhaar-step3').hidden = false;
  });

  document.getElementById('janaadhaar-validate-btn').addEventListener('click', async () => {
    const transactionId = newTransactionId();
    const otp = document.getElementById('janaadhaar-otp-input').value.trim();
    const result = await validateOtp({
      appCode: state.appCode,
      schemShortCode: state.schemShortCode,
      transactionId,
      memberId: state.selectedMemberId,
      tid: state.tid,
      otp,
    });
    logEnvelope('3. OTP सत्यापन / validate-otp', result);
    if (showError(result)) return;

    const data = result.response.decryptedPayload;
    const resultEl = document.getElementById('janaadhaar-result');
    resultEl.hidden = false;
    resultEl.innerHTML = '';

    const nameP = document.createElement('p');
    const nameStrong = document.createElement('strong');
    nameStrong.textContent = data.NAME_LL;
    nameP.append(nameStrong, ` (${data.NAME_EN})`);
    resultEl.appendChild(nameP);

    const dobP = document.createElement('p');
    dobP.textContent = `DOB: ${data.DOB} · Gender: ${data.GENDER}`;
    resultEl.appendChild(dobP);

    const useDataBtn = document.createElement('button');
    useDataBtn.type = 'button';
    useDataBtn.id = 'janaadhaar-use-data';
    useDataBtn.className = 'chip-btn';
    useDataBtn.textContent = 'यह जानकारी उपयोग करें';
    resultEl.appendChild(useDataBtn);

    useDataBtn.addEventListener('click', () => {
      const birthYear = parseInt(data.DOB.slice(0, 4), 10);
      const age = new Date().getFullYear() - birthYear;
      const slots = {
        gender: data.GENDER.toLowerCase(),
        age,
      };
      if (data.annual_income !== undefined) slots.annual_income = data.annual_income;
      if (data.category !== undefined) slots.category = data.category;
      if (data.district !== undefined) slots.district = data.district;
      if (context && context.onAutofill) context.onAutofill(slots);
      closeModal();
    });
  });
}
