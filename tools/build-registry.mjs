// P4 + R1 + P0: validates data/schemes.json (amount_inr/rate_policy rule,
// README.md scheme-count agreement), then publishes it as a versioned
// static API under api/v1/. Plain Node, no dependencies, per this
// project's no-build-step constraint. Re-running is safe: files are
// fully regenerated from data/schemes.json each time, and the
// append-only api/v1/versions.json only grows when the registry's
// version or scheme count actually changes (see computeRegistryVersion
// and publishApi's needsNewEntry check below).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { findAmountPolicyViolations } from '../js/amount-policy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SCHEMES_PATH = path.join(ROOT, 'data', 'schemes.json');
const README_PATH = path.join(ROOT, 'README.md');
const API_DIR = path.join(ROOT, 'api', 'v1');
const SCHEMES_DIR = path.join(API_DIR, 'schemes');
const VERSIONS_PATH = path.join(API_DIR, 'versions.json');
const INDEX_PATH = path.join(API_DIR, 'index.json');

// P0: catches the recurring "README still says 8, registry now serves 34"
// defect (three occurrences before this check existed). Matches "N schemes"
// (whitespace + plural "schemes", so sub-counts phrased differently and
// hyphenated adjectives like "26-scheme merge" naturally don't match) and
// flags any non-exempt occurrence whose number isn't the live count. A
// leading "~" exempts an approximate/external figure (e.g. "~348 schemes"
// in bureaucratic Hindi, statewide — not this registry's count).
const README_SCHEME_COUNT_RE = /(~)?\b(\d+)\s+schemes\b/g;

function findReadmeSchemeCountMismatches(actualCount) {
  const text = readFileSync(README_PATH, 'utf8');
  const mismatches = [];
  let match;
  while ((match = README_SCHEME_COUNT_RE.exec(text))) {
    const [full, tilde, numStr] = match;
    if (tilde) continue;
    if (Number(numStr) === actualCount) continue;
    const lineNo = text.slice(0, match.index).split('\n').length;
    mismatches.push({ line: lineNo, text: full });
  }
  return mismatches;
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function writeJson(filePath, data) {
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// The registry's published version tracks the newest per-scheme
// dataset_version it contains — reusing that existing, human-maintained
// provenance stamp instead of inventing a second, disconnected counter.
function computeRegistryVersion(schemes) {
  return schemes.reduce(
    (max, s) => (s.dataset_version > max ? s.dataset_version : max),
    schemes[0].dataset_version
  );
}

function buildIndexEntry(scheme) {
  return {
    scheme_id: scheme.scheme_id,
    name_hi: scheme.name_hi,
    name_en: scheme.name_en,
    department: scheme.department,
    last_verified: scheme.last_verified,
  };
}

function buildChangelog(previousIndex, schemes) {
  const currentIds = new Set(schemes.map((s) => s.scheme_id));
  if (!previousIndex) return `Initial publish: ${schemes.length} schemes.`;

  const previousIds = new Set(previousIndex.map((s) => s.scheme_id));
  const added = [...currentIds].filter((id) => !previousIds.has(id));
  const removed = [...previousIds].filter((id) => !currentIds.has(id));

  const parts = [];
  if (added.length) parts.push(`+${added.length} added (${added.join(', ')})`);
  if (removed.length) parts.push(`-${removed.length} removed (${removed.join(', ')})`);
  if (parts.length === 0) parts.push(`Data revised, scheme count unchanged (${schemes.length}).`);
  return parts.join('; ');
}

function publishApi(schemes) {
  ensureDir(SCHEMES_DIR);

  const version = computeRegistryVersion(schemes);
  const generatedAt = new Date().toISOString();

  // Snapshot the previous build's index BEFORE overwriting it, so the
  // changelog can diff against what was actually published last time.
  const previousIndex = readJsonIfExists(INDEX_PATH);

  const registry = { version, generated_at: generatedAt, count: schemes.length, schemes };
  writeJson(path.join(API_DIR, 'schemes.json'), registry);

  for (const scheme of schemes) {
    writeJson(path.join(SCHEMES_DIR, `${scheme.scheme_id}.json`), scheme);
  }

  const index = schemes.map(buildIndexEntry);
  writeJson(INDEX_PATH, index);

  const versions = readJsonIfExists(VERSIONS_PATH) || [];
  const lastEntry = versions[versions.length - 1];
  // Append whenever the version stamp changed OR the scheme count changed —
  // version alone isn't reliable: a scheme can be added/removed without its
  // dataset_version being the new max (e.g. an older stamp copy-pasted onto
  // a new record), which would otherwise leave versions.json's last count
  // silently wrong relative to what schemes.json/index.json now publish.
  const needsNewEntry = !lastEntry || lastEntry.version !== version || lastEntry.count !== schemes.length;
  if (needsNewEntry) {
    versions.push({
      version,
      date: generatedAt.slice(0, 10),
      count: schemes.length,
      changelog: buildChangelog(previousIndex, schemes),
    });
    writeJson(VERSIONS_PATH, versions);
  }

  return { version, versionsAppended: needsNewEntry };
}

function main() {
  const schemes = JSON.parse(readFileSync(SCHEMES_PATH, 'utf8'));
  const violations = findAmountPolicyViolations(schemes);

  if (violations.length > 0) {
    console.error(`build-registry: ${violations.length} scheme(s) have a rupee figure in amount_text_hi, amount_inr === null, and no rate_policy explaining why:`);
    for (const id of violations) console.error(`  - ${id}`);
    process.exit(1);
  }
  console.log(`build-registry: OK — ${schemes.length} schemes checked, 0 amount_inr/rate_policy violations.`);

  const readmeMismatches = findReadmeSchemeCountMismatches(schemes.length);
  if (readmeMismatches.length > 0) {
    console.error(`build-registry: README.md states a scheme count that disagrees with data/schemes.json (${schemes.length} schemes):`);
    for (const m of readmeMismatches) console.error(`  - line ${m.line}: "${m.text}"`);
    process.exit(1);
  }
  console.log(`build-registry: OK — README.md scheme counts agree with data/schemes.json (${schemes.length}).`);

  const { version, versionsAppended } = publishApi(schemes);
  console.log(`build-registry: published api/v1/ — version ${version}, ${schemes.length} schemes${versionsAppended ? ' (new versions.json entry appended)' : ' (versions.json unchanged, same version)'}.`);
}

main();
