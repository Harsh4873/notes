import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const canonicalPath = resolve(repository, 'firestore.rules');
const canonical = readFileSync(canonicalPath);
const expectedHash = readFileSync(
  resolve(repository, 'shared-firestore-rules.sha256'),
  'utf8',
).trim();
const actualHash = createHash('sha256').update(canonical).digest('hex');

if (actualHash !== expectedHash) {
  throw new Error(
    `firestore.rules hash is ${actualHash}, expected ${expectedHash}. `
    + 'Review the full shared ruleset and update every sibling copy before changing the recorded hash.',
  );
}

const siblingNames = ['gym', 'daymark', 'fare', 'slate', 'research', 'degree'];
let compared = 0;

for (const siblingName of siblingNames) {
  const siblingPath = resolve(repository, '..', siblingName, 'firestore.rules');
  if (!existsSync(siblingPath)) continue;
  compared += 1;
  const sibling = readFileSync(siblingPath);
  if (!canonical.equals(sibling)) {
    throw new Error(`${siblingName}/firestore.rules differs from the canonical Notes copy.`);
  }
}

console.log(
  compared
    ? `Shared Firestore rules match across Notes and ${compared} sibling repositories.`
    : 'Canonical Firestore rules match the reviewed release hash.',
);
