#!/usr/bin/env node

/**
 * Guarded migration of the owner's private harsh.bet data into one shared
 * Firestore vault. This script intentionally contains no account identifiers,
 * email addresses, credentials, or vault ids. Supply them at runtime.
 *
 * Required environment:
 *   OWNER_PRIMARY_UID, OWNER_SECONDARY_UID, OWNER_VAULT_ID, RECOVERY_DIR,
 *   OWNER_RECOVERY_KEY
 * Optional:
 *   OWNER_RECOVERY_KEY_REFERENCE,
 *   GOOGLE_OAUTH_ACCESS_TOKEN (otherwise `gcloud auth print-access-token`)
 *
 * Phases:
 *   snapshot  export both legacy trees to a mode-0600 recovery bundle
 *   degree-history  recover the newest retained nonempty primary Degree version
 *   degree-check  validate the protected primary recovery candidate, no writes
 *   prepare   create migrating memberships with legacy writes still enabled
 *   copy      re-read, merge, and write the shared vault (primary Degree wins)
 *   freeze    block legacy writes while both new clients remain migration-gated
 *   activate  validate the shared copy and activate both memberships
 *   verify    re-check every migrated document and the active membership gate
 *   vault-snapshot  export the verified shared destination for recovery
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

const PROJECT_ID = 'pickledgerpro';
const DATABASE_ID = '(default)';
const API_ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}`;
const DOCUMENT_ROOT = `projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents`;

const FAMILY_LAYOUTS = [
  { collection: 'degree_users', root: true, children: [] },
  { collection: 'daymark_users', root: true, children: ['habits', 'entries'] },
  { collection: 'slate_users', root: true, children: ['sections', 'tasks', 'blocks'] },
  { collection: 'fare_users', root: false, children: ['profile', 'targets', 'settings', 'foods', 'meals', 'entries'] },
  { collection: 'research_users', root: false, children: ['profile', 'settings', 'papers', 'notes', 'messages'] },
  { collection: 'notes_users', root: false, children: ['notes', 'folders', 'settings'] },
  { collection: 'recall_users', root: false, children: ['sets', 'progress'] },
  { collection: 'users', root: false, children: ['gym', 'logs'] },
];

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

const phase = argument('phase');
const label = argument('label') ?? phase ?? 'snapshot';
const primaryUid = process.env.OWNER_PRIMARY_UID ?? '';
const secondaryUid = process.env.OWNER_SECONDARY_UID ?? '';
const vaultId = process.env.OWNER_VAULT_ID ?? '';
const recoveryDir = process.env.RECOVERY_DIR ? resolve(process.env.RECOVERY_DIR) : '';
const migrationId = process.env.OWNER_MIGRATION_ID ?? `owner-vault-${new Date().toISOString().slice(0, 10)}`;
const recoveryKey = process.env.OWNER_RECOVERY_KEY ?? '';
const recoveryKeyReference = process.env.OWNER_RECOVERY_KEY_REFERENCE ?? '';

function fail(message) {
  throw new Error(message);
}

function safeId(value, labelName) {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(value)) fail(`${labelName} is missing or unsafe.`);
  return value;
}

if (!['snapshot', 'degree-history', 'degree-check', 'prepare', 'copy', 'freeze', 'activate', 'verify', 'vault-snapshot'].includes(phase ?? '')) {
  fail('Use --phase=snapshot|degree-history|degree-check|prepare|copy|freeze|activate|verify|vault-snapshot.');
}
safeId(primaryUid, 'OWNER_PRIMARY_UID');
safeId(secondaryUid, 'OWNER_SECONDARY_UID');
safeId(vaultId, 'OWNER_VAULT_ID');
if (primaryUid === secondaryUid) fail('The two owner UIDs must be distinct.');
if (vaultId === primaryUid || vaultId === secondaryUid) fail('OWNER_VAULT_ID must not reuse a legacy UID.');
if (!recoveryDir) fail('RECOVERY_DIR is required.');

function parsedRecoveryKey() {
  const key = Buffer.from(recoveryKey, 'base64');
  if (key.length !== 32) fail('OWNER_RECOVERY_KEY must be a base64-encoded 32-byte key.');
  return key;
}

mkdirSync(recoveryDir, { recursive: true, mode: 0o700 });
chmodSync(recoveryDir, 0o700);

const token = process.env.GOOGLE_OAUTH_ACCESS_TOKEN?.trim() || execFileSync(
  'gcloud',
  ['auth', 'print-access-token'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
).trim();
if (!token) fail('No Google OAuth access token is available.');

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

async function request(path, init = {}, allowed = []) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`${API_ROOT}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (response.ok) return response.status === 204 ? null : response.json();
    if (allowed.includes(response.status)) return null;
    const text = await response.text();
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      await delay(300 * (attempt + 1));
      continue;
    }
    fail(`Firestore REST ${response.status} for ${path}: ${text.slice(0, 300)}`);
  }
  fail(`Firestore REST retries exhausted for ${path}.`);
}

function encodedPath(...segments) {
  return segments.map((segment) => encodeURIComponent(segment)).join('/');
}

async function getDocument(...segments) {
  return request(`/documents/${encodedPath(...segments)}`, {}, [404]);
}

async function getDocumentAt(readTime, ...segments) {
  const query = new URLSearchParams({ readTime });
  return request(`/documents/${encodedPath(...segments)}?${query.toString()}`, {}, [404]);
}

async function listDocuments(segments) {
  const documents = [];
  let pageToken = '';
  do {
    const query = new URLSearchParams({ pageSize: '300' });
    if (pageToken) query.set('pageToken', pageToken);
    const result = await request(`/documents/${encodedPath(...segments)}?${query.toString()}`);
    documents.push(...(result?.documents ?? []));
    pageToken = result?.nextPageToken ?? '';
  } while (pageToken);
  return documents;
}

async function readAccount(uid) {
  const entries = [];
  for (const layout of FAMILY_LAYOUTS) {
    if (layout.root) {
      const document = await getDocument(layout.collection, uid);
      if (document) entries.push({
        family: layout.collection,
        child: null,
        id: uid,
        document,
      });
    }
    for (const child of layout.children) {
      const documents = await listDocuments([layout.collection, uid, child]);
      for (const document of documents) entries.push({
        family: layout.collection,
        child,
        id: document.name.split('/').at(-1),
        document,
      });
    }
  }
  return entries;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function encryptBundle(bundle) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', parsedRecoveryKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(bundle), 'utf8'),
    cipher.final(),
  ]);
  return {
    schemaVersion: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decryptBundle(snapshotLabel) {
  const encrypted = JSON.parse(readFileSync(resolve(recoveryDir, `${snapshotLabel}.json.enc`), 'utf8'));
  if (encrypted.schemaVersion !== 1 || encrypted.algorithm !== 'aes-256-gcm') {
    fail(`Recovery bundle ${snapshotLabel} uses an unsupported encryption envelope.`);
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    parsedRecoveryKey(),
    Buffer.from(encrypted.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(plaintext);
}

function writeEncryptedBundle(snapshotLabel, bundle) {
  const file = resolve(recoveryDir, `${snapshotLabel}.json.enc`);
  writeFileSync(file, `${JSON.stringify(encryptBundle(bundle))}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

function decodeValue(value) {
  if (!value || typeof value !== 'object') return null;
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('timestampValue' in value) return value.timestampValue;
  if ('stringValue' in value) return value.stringValue;
  if ('bytesValue' in value) return value.bytesValue;
  if ('referenceValue' in value) return value.referenceValue;
  if ('geoPointValue' in value) return value.geoPointValue;
  if ('arrayValue' in value) return (value.arrayValue.values ?? []).map(decodeValue);
  if ('mapValue' in value) return decodeFields(value.mapValue.fields ?? {});
  return null;
}

function decodeFields(fields = {}) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeValue(value)]));
}

function entryKey(entry) {
  return `${entry.family}/${entry.child ?? '@root'}/${entry.id}`;
}

function logicalStamp(entry) {
  const fields = decodeFields(entry.document.fields);
  const candidates = [
    fields.updatedAtMs,
    fields.generationUpdatedAtMs,
    fields.lastModifiedMs,
    fields.updatedAt,
    fields.generationUpdatedAt,
    fields.lastModified,
    entry.document.updateTime,
  ];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

function choose(primary, secondary) {
  if (!primary) return secondary;
  if (!secondary) return primary;
  const order = logicalStamp(primary) - logicalStamp(secondary);
  if (order !== 0) return order > 0 ? primary : secondary;
  // Deterministic owner preference when timestamps tie or predate clocks.
  return primary;
}

function degreeSummary(entry) {
  if (!entry) return { valid: false, terms: 0, courses: 0 };
  const fields = decodeFields(entry.document.fields);
  const terms = Array.isArray(fields.planner?.terms) ? fields.planner.terms : [];
  const courses = terms.reduce((total, term) => total + (Array.isArray(term?.courses) ? term.courses.length : 0), 0);
  return {
    valid: fields.schemaVersion === 1 && terms.length > 0 && courses > 0,
    terms: terms.length,
    courses,
  };
}

function encodeFirestoreValue(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('A recovered Degree value is not finite.');
    return Number.isInteger(value) ? integerValue(value) : { doubleValue: value };
  }
  if (typeof value === 'string') return stringValue(value);
  if (Array.isArray(value)) return {
    arrayValue: { values: value.map(encodeFirestoreValue) },
  };
  if (value && typeof value === 'object') return {
    mapValue: {
      fields: Object.fromEntries(
        Object.entries(value)
          .filter(([, entry]) => entry !== undefined)
          .map(([key, entry]) => [key, encodeFirestoreValue(entry)]),
      ),
    },
  };
  fail('A recovered Degree value has an unsupported type.');
}

function localPrimaryDegree() {
  try {
    const bundle = decryptBundle('degree-local');
    const planner = bundle?.planner;
    if (!planner || !Array.isArray(planner.terms)) return null;
    const wirePlanner = {
      ...planner,
      terms: planner.terms.map((term) => ({
        ...term,
        courses: Array.isArray(term.courses) ? term.courses.map((course) => {
          if (!Array.isArray(course.prerequisitePaths)) return course;
          return {
            ...course,
            prerequisitePaths: course.prerequisitePaths.map((courses) => ({ courses })),
          };
        }) : [],
      })),
    };
    const updatedAtMs = Date.now();
    const document = {
      name: `${DOCUMENT_ROOT}/degree_users/${primaryUid}`,
      fields: encodeFirestoreValue({
        schemaVersion: 1,
        planner: wirePlanner,
        updatedAt: new Date(updatedAtMs).toISOString(),
        updatedAtMs,
        clientId: 'owner-vault-browser-recovery',
      }).mapValue.fields,
    };
    const entry = { family: 'degree_users', child: null, id: primaryUid, document };
    return degreeSummary(entry).valid ? entry : null;
  } catch {
    return null;
  }
}

function historicalPrimaryDegree() {
  try {
    const bundle = decryptBundle('degree-history');
    const candidate = [...(bundle.candidates ?? [])]
      .reverse()
      .find((entry) => degreeSummary(entry).valid);
    return candidate ?? localPrimaryDegree();
  } catch {
    return localPrimaryDegree();
  }
}

function mergeAccounts(primary, secondary) {
  const currentPrimaryDegree = primary.find((entry) => entry.family === 'degree_users' && entry.child === null);
  const currentSummary = degreeSummary(currentPrimaryDegree);
  const primaryDegree = currentSummary.valid ? currentPrimaryDegree : historicalPrimaryDegree();
  const summary = degreeSummary(primaryDegree);
  if (!summary.valid) {
    fail('Protected primary Degree plan is absent or has no courses, including retained history. Migration stopped before shared-vault writes.');
  }

  const merged = [primaryDegree];
  const skipFamilies = new Set(['degree_users', 'daymark_users']);
  const primaryMap = new Map(primary.filter((entry) => !skipFamilies.has(entry.family)).map((entry) => [entryKey(entry), entry]));
  const secondaryMap = new Map(secondary.filter((entry) => !skipFamilies.has(entry.family)).map((entry) => [entryKey(entry), entry]));
  const ordinaryKeys = new Set([...primaryMap.keys(), ...secondaryMap.keys()]);
  for (const key of ordinaryKeys) merged.push(choose(primaryMap.get(key), secondaryMap.get(key)));

  // Daymark publishes whole generations. Pick one root atomically; if both
  // accounts happen to reference the same generation, merge its record ids.
  const primaryRoot = primary.find((entry) => entry.family === 'daymark_users' && entry.child === null);
  const secondaryRoot = secondary.find((entry) => entry.family === 'daymark_users' && entry.child === null);
  const daymarkRoot = choose(primaryRoot, secondaryRoot);
  if (daymarkRoot) {
    merged.push(daymarkRoot);
    const generationId = decodeFields(daymarkRoot.document.fields).generationId;
    const daymarkEntries = [...primary, ...secondary].filter((entry) => {
      if (entry.family !== 'daymark_users' || entry.child === null) return false;
      return decodeFields(entry.document.fields).generationId === generationId;
    });
    const byKey = new Map();
    for (const entry of daymarkEntries) {
      const key = entryKey(entry);
      byKey.set(key, choose(byKey.get(key), entry));
    }
    merged.push(...byKey.values());
  }

  return {
    entries: merged.filter(Boolean),
    degree: summary,
    degreeEntry: primaryDegree,
    degreeSource: currentSummary.valid
      ? 'current-primary'
      : primaryDegree?.readTime
        ? 'retained-primary-version'
        : 'browser-local-primary-recovery',
  };
}

function destinationName(entry) {
  const suffix = entry.child ? `/${entry.child}/${entry.id}` : '';
  return `${DOCUMENT_ROOT}/${entry.family}/${vaultId}${suffix}`;
}

function stringValue(value) {
  return { stringValue: value };
}

function integerValue(value) {
  return { integerValue: String(value) };
}

function booleanValue(value) {
  return { booleanValue: value };
}

async function commitDocuments(documents) {
  for (let index = 0; index < documents.length; index += 200) {
    const chunk = documents.slice(index, index + 200);
    await request('/documents:commit', {
      method: 'POST',
      body: JSON.stringify({
        writes: chunk.map((document) => ({ update: document })),
      }),
    });
  }
}

async function deleteDocuments(documentNames) {
  for (let index = 0; index < documentNames.length; index += 200) {
    const chunk = documentNames.slice(index, index + 200);
    await request('/documents:commit', {
      method: 'POST',
      body: JSON.stringify({
        writes: chunk.map((name) => ({ delete: name })),
      }),
    });
  }
}

function membershipDocument(uid, status, legacyWritesEnabled) {
  return {
    name: `${DOCUMENT_ROOT}/owner_vault_members/${uid}`,
    fields: {
      schemaVersion: integerValue(1),
      vaultId: stringValue(vaultId),
      status: stringValue(status),
      legacyWritesEnabled: booleanValue(legacyWritesEnabled),
      migrationId: stringValue(migrationId),
      updatedAtMs: integerValue(Date.now()),
    },
  };
}

function vaultMetadata(status, documentCount = 0) {
  return {
    name: `${DOCUMENT_ROOT}/owner_vaults/${vaultId}`,
    fields: {
      schemaVersion: integerValue(1),
      status: stringValue(status),
      migrationId: stringValue(migrationId),
      documentCount: integerValue(documentCount),
      updatedAtMs: integerValue(Date.now()),
    },
  };
}

function recoveryDocument(snapshotLabel, accountDigest, documentCount) {
  const safeLabel = snapshotLabel.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80);
  return {
    name: `${DOCUMENT_ROOT}/owner_vaults/${vaultId}/recovery/${safeLabel}`,
    fields: {
      schemaVersion: integerValue(1),
      migrationId: stringValue(migrationId),
      snapshotDigest: stringValue(accountDigest),
      documentCount: integerValue(documentCount),
      capturedAtMs: integerValue(Date.now()),
    },
  };
}

async function capture(snapshotLabel) {
  const [primary, secondary] = await Promise.all([
    readAccount(primaryUid),
    readAccount(secondaryUid),
  ]);
  const bundle = {
    schemaVersion: 1,
    migrationId,
    capturedAt: new Date().toISOString(),
    accounts: { primary, secondary },
  };
  const accountDigests = {
    primary: digest(primary),
    secondary: digest(secondary),
  };
  const bundleDigest = digest(bundle);
  writeEncryptedBundle(snapshotLabel, bundle);
  const manifest = {
    schemaVersion: 1,
    migrationId,
    label: snapshotLabel,
    bundleDigest,
    encryption: {
      algorithm: 'aes-256-gcm',
      keyReference: recoveryKeyReference || 'runtime-provided',
    },
    accountDigests,
    counts: { primary: primary.length, secondary: secondary.length },
    degree: {
      primary: degreeSummary(primary.find((entry) => entry.family === 'degree_users' && entry.child === null)),
      secondary: degreeSummary(secondary.find((entry) => entry.family === 'degree_users' && entry.child === null)),
    },
  };
  const manifestFile = resolve(recoveryDir, `${snapshotLabel}.manifest.json`);
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  chmodSync(manifestFile, 0o600);
  return { primary, secondary, manifest };
}

async function captureActiveVault(snapshotLabel) {
  const entries = await readAccount(vaultId);
  const bundle = {
    schemaVersion: 1,
    migrationId,
    capturedAt: new Date().toISOString(),
    vault: entries,
  };
  const bundleDigest = digest(bundle);
  writeEncryptedBundle(snapshotLabel, bundle);
  const manifest = {
    schemaVersion: 1,
    migrationId,
    label: snapshotLabel,
    bundleDigest,
    encryption: {
      algorithm: 'aes-256-gcm',
      keyReference: recoveryKeyReference || 'runtime-provided',
    },
    count: entries.length,
    degree: degreeSummary(entries.find((entry) => entry.family === 'degree_users' && entry.child === null)),
  };
  const manifestFile = resolve(recoveryDir, `${snapshotLabel}.manifest.json`);
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  chmodSync(manifestFile, 0o600);
  return manifest;
}

function loadManifest(snapshotLabel) {
  return JSON.parse(readFileSync(resolve(recoveryDir, `${snapshotLabel}.manifest.json`), 'utf8'));
}

async function copySnapshot(snapshotLabel) {
  const { primary, secondary, manifest } = await capture(snapshotLabel);
  const merged = mergeAccounts(primary, secondary);
  const documents = merged.entries.map((entry) => ({
    name: destinationName(entry),
    fields: entry.document.fields ?? {},
  }));
  // `copy` is a mirror, not an append. This matters for the final pass after
  // legacy writes are frozen: a document deleted between the pre-freeze copy
  // and the final read must not survive in the shared vault, and stale
  // Daymark generations must not accumulate behind the active root.
  const existingDestination = await readAccount(vaultId);
  const expectedNames = new Set(documents.map((document) => document.name));
  const staleNames = existingDestination
    .map(destinationName)
    .filter((name) => !expectedNames.has(name));
  await commitDocuments(documents);
  await deleteDocuments(staleNames);
  await commitDocuments([
    vaultMetadata('migrating', documents.length),
    recoveryDocument(`${snapshotLabel}-primary`, manifest.accountDigests.primary, primary.length),
    recoveryDocument(`${snapshotLabel}-secondary`, manifest.accountDigests.secondary, secondary.length),
  ]);
  const protectedDegree = {
    source: merged.degreeSource,
    digest: digest(merged.degreeEntry.document.fields),
    summary: merged.degree,
  };
  const completedManifest = {
    ...manifest,
    mergedDocumentCount: documents.length,
    protectedDegree,
  };
  const manifestFile = resolve(recoveryDir, `${snapshotLabel}.manifest.json`);
  writeFileSync(manifestFile, `${JSON.stringify(completedManifest, null, 2)}\n`, { mode: 0o600 });
  chmodSync(manifestFile, 0o600);
  return {
    count: documents.length,
    removed: staleNames.length,
    degree: merged.degree,
    manifest: completedManifest,
  };
}

async function validateDestination(snapshotLabel) {
  const manifest = loadManifest(snapshotLabel);
  const bundle = decryptBundle(snapshotLabel);
  const merged = mergeAccounts(bundle.accounts.primary, bundle.accounts.secondary);
  const expected = new Map(merged.entries.map((entry) => [
    destinationName(entry),
    digest(entry.document.fields),
  ]));
  const degreeName = `${DOCUMENT_ROOT}/degree_users/${vaultId}`;
  if (!manifest.protectedDegree) fail('Protected Degree manifest is missing during activation validation.');
  // A browser-recovered plan receives its migration timestamp while `copy`
  // runs. Reconstructing the candidate now would mint another timestamp, so
  // the copy manifest's exact field digest is the authoritative Degree value.
  expected.set(degreeName, manifest.protectedDegree.digest);

  const destinationEntries = await readAccount(vaultId);
  const actual = new Map(destinationEntries.map((entry) => [
    destinationName(entry),
    digest(entry.document.fields),
  ]));
  if (actual.size !== expected.size) {
    fail(`Shared-vault document count mismatch: expected ${expected.size}, found ${actual.size}.`);
  }
  for (const [name, expectedDigest] of expected) {
    if (actual.get(name) !== expectedDigest) {
      fail(`Shared-vault document mismatch at ${name.replace(`${DOCUMENT_ROOT}/`, '')}.`);
    }
  }
  const destinationDegree = destinationEntries.find((entry) => destinationName(entry) === degreeName)?.document;
  if (!destinationDegree) fail('Protected Degree document is missing during activation validation.');
  if (!degreeSummary({ document: destinationDegree }).valid) {
    fail('Protected Degree destination does not contain a valid nonempty plan.');
  }
  return { manifest, documentCount: actual.size };
}

async function verifyActiveVault(snapshotLabel) {
  const validated = await validateDestination(snapshotLabel);
  const [primaryMembership, secondaryMembership, metadata] = await Promise.all([
    getDocument('owner_vault_members', primaryUid),
    getDocument('owner_vault_members', secondaryUid),
    getDocument('owner_vaults', vaultId),
  ]);
  for (const membership of [primaryMembership, secondaryMembership]) {
    const fields = decodeFields(membership?.fields);
    if (
      fields.schemaVersion !== 1
      || fields.vaultId !== vaultId
      || fields.status !== 'active'
      || fields.legacyWritesEnabled !== false
    ) {
      fail('An owner membership is not active on the frozen shared vault.');
    }
  }
  const metadataFields = decodeFields(metadata?.fields);
  if (
    metadataFields.schemaVersion !== 1
    || metadataFields.status !== 'active'
    || metadataFields.documentCount !== validated.documentCount
  ) {
    fail('The shared-vault metadata does not match the verified active copy.');
  }
  return validated;
}

async function main() {
  if (phase === 'snapshot') {
    const { manifest } = await capture(label);
    console.log(JSON.stringify({
      phase,
      counts: manifest.counts,
      degree: manifest.degree,
      bundleDigest: manifest.bundleDigest,
    }));
    return;
  }

  if (phase === 'degree-history') {
    const database = await request('');
    const earliest = Date.parse(database?.earliestVersionTime ?? '');
    const now = Date.now();
    if (!Number.isFinite(earliest) || earliest >= now) fail('Firestore did not expose a usable retained-version window.');
    const sampleTimes = [];
    for (let at = earliest + 1_000; at <= now; at += 30_000) sampleTimes.push(new Date(at).toISOString());
    sampleTimes.push(new Date(now).toISOString());
    const samples = [];
    for (let index = 0; index < sampleTimes.length; index += 12) {
      const times = sampleTimes.slice(index, index + 12);
      const documents = await Promise.all(times.map((readTime) => getDocumentAt(readTime, 'degree_users', primaryUid)));
      for (let offset = 0; offset < times.length; offset += 1) {
        const document = documents[offset];
        if (!document) continue;
        const entry = { family: 'degree_users', child: null, id: primaryUid, document, readTime: times[offset] };
        if (degreeSummary(entry).valid) samples.push(entry);
      }
    }
    const unique = [];
    const seen = new Set();
    for (const entry of samples) {
      const fieldDigest = digest(entry.document.fields);
      if (seen.has(fieldDigest)) continue;
      seen.add(fieldDigest);
      unique.push(entry);
    }
    if (unique.length > 0) {
      writeEncryptedBundle('degree-history', {
        schemaVersion: 1,
        capturedAt: new Date().toISOString(),
        candidates: unique,
      });
    }
    console.log(JSON.stringify({
      phase,
      retainedCandidates: unique.length,
      candidates: unique.map((entry) => degreeSummary(entry)),
    }));
    return;
  }

  if (phase === 'degree-check') {
    const [primary, secondary] = await Promise.all([readAccount(primaryUid), readAccount(secondaryUid)]);
    const merged = mergeAccounts(primary, secondary);
    console.log(JSON.stringify({ phase, source: merged.degreeSource, degree: merged.degree }));
    return;
  }

  if (phase === 'prepare') {
    await commitDocuments([
      membershipDocument(primaryUid, 'migrating', true),
      membershipDocument(secondaryUid, 'migrating', true),
      vaultMetadata('migrating'),
    ]);
    console.log(JSON.stringify({ phase, status: 'migrating', legacyWritesEnabled: true }));
    return;
  }

  if (phase === 'copy') {
    const result = await copySnapshot(label);
    console.log(JSON.stringify({
      phase,
      label,
      documents: result.count,
      removed: result.removed,
      degree: result.degree,
    }));
    return;
  }

  if (phase === 'freeze') {
    await commitDocuments([
      membershipDocument(primaryUid, 'migrating', false),
      membershipDocument(secondaryUid, 'migrating', false),
      vaultMetadata('frozen'),
    ]);
    console.log(JSON.stringify({ phase, status: 'migrating', legacyWritesEnabled: false }));
    return;
  }

  if (phase === 'activate') {
    const { manifest } = await validateDestination(label);
    await commitDocuments([
      membershipDocument(primaryUid, 'active', false),
      membershipDocument(secondaryUid, 'active', false),
      vaultMetadata('active', manifest.mergedDocumentCount),
    ]);
    console.log(JSON.stringify({
      phase,
      status: 'active',
      legacyWritesEnabled: false,
      degree: manifest.protectedDegree.summary,
    }));
    return;
  }

  if (phase === 'verify') {
    const { manifest, documentCount } = await verifyActiveVault(label);
    console.log(JSON.stringify({
      phase,
      status: 'active',
      documents: documentCount,
      legacyWritesEnabled: false,
      degree: manifest.protectedDegree.summary,
    }));
    return;
  }

  if (phase === 'vault-snapshot') {
    await verifyActiveVault('final');
    const snapshotLabel = label === phase ? 'active-vault' : label;
    const manifest = await captureActiveVault(snapshotLabel);
    console.log(JSON.stringify({
      phase,
      label: snapshotLabel,
      documents: manifest.count,
      degree: manifest.degree,
      bundleDigest: manifest.bundleDigest,
    }));
  }
}

main().catch((error) => {
  console.error(`Owner-vault migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
