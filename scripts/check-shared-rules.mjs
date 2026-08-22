// Every private app in the shared Firebase project ships the same
// firestore.rules. Two things keep the copies in step:
//
//   1. shared-firestore-rules.sha256 pins the reviewed digest of that shared
//      ruleset. Checking the Notes rules against that local pin is therefore a
//      real parity check, and it is
//      the only half a single-repository checkout (CI) is able to run.
//   2. When the sibling repositories happen to sit next to this one on a
//      developer machine, their files are also compared byte for byte.
//
// The check must never report success for work it did not do. A partial or
// impossible sibling comparison is a hard failure, and a run that could only
// verify the recorded digest says exactly that instead of printing a bare
// "rules match" line.

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIBLING_NAMES = ['gym', 'daymark', 'fare', 'slate', 'research', 'degree', 'recipes', 'radar', 'goals'];
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rulesPath = resolve(repository, 'firestore.rules');
const pinPath = resolve(repository, 'shared-firestore-rules.sha256');

function fail(headline, ...details) {
  console.error(`Shared Firestore rules check FAILED: ${headline}`);
  for (const detail of details) console.error(`  ${detail}`);
  process.exit(1);
}

function read(path, label) {
  try {
    return readFileSync(path);
  } catch (error) {
    return fail(`${label} could not be read.`, path, String(error?.message ?? error));
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// 1. The local ruleset against the reviewed digest. Always runnable, always
//    required — this is what makes the check meaningful in a CI checkout that
//    only ever contains this one repository.
const canonical = read(rulesPath, 'firestore.rules');
if (canonical.length === 0) fail('firestore.rules is empty.', rulesPath);

const expectedDigest = read(pinPath, 'shared-firestore-rules.sha256').toString('utf8').trim();
if (!DIGEST_PATTERN.test(expectedDigest)) {
  fail(
    'shared-firestore-rules.sha256 does not contain a sha256 digest.',
    pinPath,
    `read: ${JSON.stringify(expectedDigest.slice(0, 120))}`,
  );
}

const actualDigest = createHash('sha256').update(canonical).digest('hex');
if (actualDigest !== expectedDigest) {
  fail(
    'firestore.rules does not match the reviewed shared ruleset.',
    `recorded ${expectedDigest}`,
    `actual   ${actualDigest}`,
    'Review the full shared ruleset, update every sibling copy, then update the recorded digest.',
  );
}

// 2. The sibling copies, when this checkout actually has them.
const siblings = SIBLING_NAMES.map((name) => {
  const siblingRepository = resolve(repository, '..', name);
  const siblingRules = resolve(siblingRepository, 'firestore.rules');
  if (!isDirectory(siblingRepository)) return { name, state: 'absent' };
  if (!isFile(siblingRules)) return { name, state: 'no-rules', siblingRules };
  const matches = read(siblingRules, `${name}/firestore.rules`).equals(canonical);
  return { name, state: matches ? 'match' : 'differs', siblingRules };
});

const named = (states) => siblings.filter((s) => states.includes(s.state)).map((s) => s.name);
const differing = named(['differs']);
const withoutRules = named(['no-rules']);
const absent = named(['absent']);
const compared = siblings.length - absent.length;

if (differing.length) {
  fail(
    `${differing.length} sibling ruleset(s) differ from the canonical Notes copy.`,
    `differs: ${differing.join(', ')}`,
    'The shared ruleset must stay byte-identical in every repository.',
  );
}

if (withoutRules.length) {
  fail(
    `${withoutRules.length} sibling repository/repositories are checked out but have no firestore.rules.`,
    `missing file: ${withoutRules.join(', ')}`,
    'Every repository in the shared Firebase project must ship the shared ruleset.',
  );
}

// Some-but-not-all is the dangerous case: it used to be reported as a pass.
if (absent.length && compared) {
  fail(
    `only ${compared} of ${siblings.length} sibling repositories are checked out, so cross-repository parity cannot be verified.`,
    `not checked out: ${absent.join(', ')}`,
    'Check out every sibling repository, or run from a single-repository checkout where the recorded digest is the contract.',
  );
}

if (compared) {
  console.log(
    `Shared Firestore rules verified: digest ${expectedDigest} and byte-identical copies in all `
    + `${compared} sibling repositories (${SIBLING_NAMES.join(', ')}).`,
  );
} else {
  console.log(
    `Shared Firestore rules verified against the recorded digest ${expectedDigest}.`,
  );
  console.log(
    `  No sibling repository is checked out here, so ${SIBLING_NAMES.join(', ')} were NOT compared `
    + 'byte for byte. Parity rests on every repository committing this same digest.',
  );
}
