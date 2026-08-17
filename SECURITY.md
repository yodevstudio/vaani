# Security

VAANI is a static, client-side-only application. This document states what
that means in practice, so it doesn't need to be taken on faith.

## What's true by construction

- **No backend.** The entire app is static HTML/CSS/JS served from GitHub
  Pages. There is no server-side code, no database, and nothing to
  compromise on our infrastructure — there isn't any.
- **No secrets in the client.** There are no API keys, tokens, or
  credentials anywhere in this repository. Nothing needs to be, since the
  app makes no calls to any third-party service.
- **No PII is stored.** `localStorage` holds exactly three things: the
  scheme dataset (`data/schemes.json`), the dialect lexicon
  (`data/lexicon.json`), and UI preferences (e.g. citizen/e-Mitra mode).
  No name, phone number, Aadhaar/Jan Aadhaar ID, transcript, or any other
  citizen-identifying data is ever written to storage.
- **All identity flows are simulated, client-side.** `js/janaadhaar-sim.js`
  implements the Jan Aadhaar Integration Document v1.8 envelope shape for
  demonstration purposes only. It never calls a real Jan Aadhaar or Raj
  Sewa Dwaar endpoint, generates only throwaway WebCrypto keypairs
  in-browser, and processes no real citizen data. It carries a permanent,
  non-dismissible banner saying so.

## Reporting a vulnerability

If you find a security issue in this repository — including in the
simulated Jan Aadhaar flow — please email **yogendra.yoji@gmail.com**
with a description and, if possible, steps to reproduce. Given the app's
architecture (no backend, no stored PII, no real external calls), the
realistic blast radius of any client-side issue is low, but we'd still
like to know.
