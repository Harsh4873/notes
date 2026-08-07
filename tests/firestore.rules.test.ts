import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  deleteDoc,
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const PROJECT_ID = 'demo-notes';
const TEST_EMAIL = 'user.one@example.com';
const OWNER_UID = 'notes-owner';
const EMULATOR_ADDRESS = process.env.FIRESTORE_EMULATOR_HOST;

function authorizedContext(
  testEnvironment: RulesTestEnvironment,
  uid = OWNER_UID,
  overrides: Record<string, unknown> = {},
): RulesTestContext {
  return testEnvironment.authenticatedContext(uid, {
    email: TEST_EMAIL,
    email_verified: true,
    firebase: { sign_in_provider: 'google.com' },
    ...overrides,
  });
}

function validNote(id = 'note-1') {
  return {
    id,
    title: 'A useful note',
    content: '<p>Copied on my phone.</p>',
    contentText: 'Copied on my phone.',
    richBackup: '',
    format: 'rich',
    folderId: 'inbox',
    labels: ['reference', 'phone'],
    pinned: false,
    revision: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

function validFolder(id = 'inbox') {
  return {
    id,
    name: 'Inbox',
    color: 'amber',
    order: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

function validSettings() {
  return {
    theme: 'system',
    smartFormatting: true,
    updatedAt: serverTimestamp(),
  };
}

describe.skipIf(!EMULATOR_ADDRESS)('Notes Firestore security rules', () => {
  let testEnvironment: RulesTestEnvironment;

  beforeAll(async () => {
    const [host, rawPort] = EMULATOR_ADDRESS!.split(':');
    const rules = await readFile(resolve(process.cwd(), 'firestore.rules'), 'utf8');

    testEnvironment = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        host,
        port: Number(rawPort),
        rules,
      },
    });
  });

  afterEach(async () => {
    if (testEnvironment) await testEnvironment.clearFirestore();
  });

  afterAll(async () => {
    if (testEnvironment) await testEnvironment.cleanup();
  });

  it('allows the verified Google owner to create, read, and update notes, folders, and settings', async () => {
    const firestore = authorizedContext(testEnvironment).firestore();
    const note = doc(firestore, 'notes_users', OWNER_UID, 'notes', 'note-1');
    const folder = doc(firestore, 'notes_users', OWNER_UID, 'folders', 'inbox');
    const settings = doc(firestore, 'notes_users', OWNER_UID, 'settings', 'current');

    await assertSucceeds(setDoc(note, validNote()));
    await assertSucceeds(setDoc(folder, validFolder()));
    await assertSucceeds(setDoc(settings, validSettings()));
    await assertSucceeds(getDoc(note));
    await assertSucceeds(getDoc(folder));
    await assertSucceeds(getDoc(settings));

    await assertSucceeds(updateDoc(note, {
      title: 'Updated from the laptop',
      revision: 1,
      updatedAt: serverTimestamp(),
    }));
    await assertSucceeds(updateDoc(folder, {
      name: 'Quick capture',
      updatedAt: serverTimestamp(),
    }));
    await assertSucceeds(updateDoc(settings, {
      theme: 'dark',
      updatedAt: serverTimestamp(),
    }));
    await assertSucceeds(updateDoc(settings, {
      smartFormatting: false,
      updatedAt: serverTimestamp(),
    }));

    const updatedNote = await getDoc(note);
    expect(updatedNote.data()?.title).toBe('Updated from the laptop');
  });

  it('denies anonymous reads and writes', async () => {
    const firestore = testEnvironment.unauthenticatedContext().firestore();
    const note = doc(firestore, 'notes_users', OWNER_UID, 'notes', 'note-1');

    await assertFails(getDoc(note));
    await assertFails(setDoc(note, validNote()));
  });

  it('allows another verified Google account to use its own UID-scoped workspace', async () => {
    const secondUid = 'second-notes-user';
    const firestore = authorizedContext(testEnvironment, secondUid, {
      email: 'someone-else@example.com',
    }).firestore();

    await assertSucceeds(
      setDoc(
        doc(firestore, 'notes_users', secondUid, 'notes', 'note-1'),
        validNote(),
      ),
    );
  });

  it('denies an unverified email', async () => {
    const firestore = authorizedContext(testEnvironment, OWNER_UID, {
      email_verified: false,
    }).firestore();

    await assertFails(
      setDoc(
        doc(firestore, 'notes_users', OWNER_UID, 'folders', 'inbox'),
        validFolder(),
      ),
    );
  });

  it('denies an email when the provider is not Google', async () => {
    const firestore = authorizedContext(testEnvironment, OWNER_UID, {
      firebase: { sign_in_provider: 'password' },
    }).firestore();

    await assertFails(
      getDoc(doc(firestore, 'notes_users', OWNER_UID, 'settings', 'current')),
    );
  });

  it('denies an authorized claim whose UID does not own the path', async () => {
    const firestore = authorizedContext(testEnvironment, 'different-user').firestore();

    await assertFails(
      setDoc(
        doc(firestore, 'notes_users', OWNER_UID, 'notes', 'note-1'),
        validNote(),
      ),
    );
  });

  it('denies malformed notes, folders, settings, and client-authored timestamps', async () => {
    const firestore = authorizedContext(testEnvironment).firestore();
    const note = doc(firestore, 'notes_users', OWNER_UID, 'notes', 'note-1');
    const folder = doc(firestore, 'notes_users', OWNER_UID, 'folders', 'inbox');
    const settings = doc(firestore, 'notes_users', OWNER_UID, 'settings', 'current');

    await assertFails(setDoc(note, { ...validNote(), unexpected: true }));
    await assertFails(setDoc(note, { ...validNote(), id: 'different-note' }));
    await assertFails(setDoc(note, { ...validNote(), title: 'x'.repeat(241) }));
    await assertFails(setDoc(note, { ...validNote(), format: 'markdown' }));
    await assertFails(setDoc(note, { ...validNote(), labels: ['valid', 42] }));
    await assertFails(setDoc(note, { ...validNote(), labels: ['   '] }));
    await assertFails(setDoc(note, { ...validNote(), revision: 1 }));
    await assertFails(setDoc(note, { ...validNote(), richBackup: 'x'.repeat(600_001) }));
    await assertFails(setDoc(note, {
      ...validNote(),
      content: 'x'.repeat(425_000),
      contentText: '',
      richBackup: 'y'.repeat(425_001),
    }));
    await assertFails(setDoc(note, {
      ...validNote(),
      createdAt: new Date('2026-07-21T12:00:00.000Z'),
      updatedAt: new Date('2026-07-21T12:00:00.000Z'),
    }));
    await assertFails(setDoc(folder, { ...validFolder(), color: 'not valid!' }));
    await assertFails(setDoc(folder, { ...validFolder(), name: ' \t\n ' }));
    await assertFails(setDoc(folder, { ...validFolder(), order: 10_001 }));
    await assertFails(setDoc(settings, { ...validSettings(), theme: 'sepia' }));
    await assertFails(setDoc(settings, { ...validSettings(), extra: 'nope' }));
  });

  it('preserves createdAt and requires a server-authored updatedAt on updates', async () => {
    const firestore = authorizedContext(testEnvironment).firestore();
    const note = doc(firestore, 'notes_users', OWNER_UID, 'notes', 'note-1');

    await assertSucceeds(setDoc(note, validNote()));
    await assertFails(updateDoc(note, {
      createdAt: serverTimestamp(),
      revision: 1,
      updatedAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(note, {
      title: 'Client-clock update',
      revision: 1,
      updatedAt: new Date('2026-07-21T12:00:00.000Z'),
    }));
  });

  it('requires every note update to advance exactly one revision', async () => {
    const firestore = authorizedContext(testEnvironment).firestore();
    const note = doc(firestore, 'notes_users', OWNER_UID, 'notes', 'note-1');

    await assertSucceeds(setDoc(note, validNote()));
    await assertFails(updateDoc(note, {
      title: 'No revision',
      updatedAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(note, {
      title: 'Skipped revision',
      revision: 2,
      updatedAt: serverTimestamp(),
    }));
    await assertSucceeds(updateDoc(note, {
      title: 'First accepted edit',
      revision: 1,
      updatedAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(note, {
      title: 'Stale device edit',
      revision: 1,
      updatedAt: serverTimestamp(),
    }));
    await assertSucceeds(updateDoc(note, {
      title: 'Second accepted edit',
      revision: 2,
      updatedAt: serverTimestamp(),
    }));
  });

  it('denies deletes for live notes, folders, and settings', async () => {
    const firestore = authorizedContext(testEnvironment).firestore();
    const note = doc(firestore, 'notes_users', OWNER_UID, 'notes', 'note-1');
    const folder = doc(firestore, 'notes_users', OWNER_UID, 'folders', 'inbox');
    const settings = doc(firestore, 'notes_users', OWNER_UID, 'settings', 'current');

    await assertSucceeds(setDoc(note, validNote()));
    await assertSucceeds(setDoc(folder, validFolder()));
    await assertSucceeds(setDoc(settings, validSettings()));
    await assertFails(deleteDoc(note));
    await assertFails(deleteDoc(folder));
    await assertFails(deleteDoc(settings));
  });

  it('allows only the owner to delete an already-trashed valid note', async () => {
    const ownerFirestore = authorizedContext(testEnvironment).firestore();
    const ownerNote = doc(ownerFirestore, 'notes_users', OWNER_UID, 'notes', 'note-1');

    await assertSucceeds(setDoc(ownerNote, validNote()));
    await assertSucceeds(updateDoc(ownerNote, {
      deleted: true,
      deletedAt: serverTimestamp(),
      revision: 1,
      updatedAt: serverTimestamp(),
    }));

    const nonOwnerFirestore = authorizedContext(testEnvironment, 'different-user').firestore();
    const nonOwnerNote = doc(nonOwnerFirestore, 'notes_users', OWNER_UID, 'notes', 'note-1');
    const anonymousFirestore = testEnvironment.unauthenticatedContext().firestore();
    const anonymousNote = doc(anonymousFirestore, 'notes_users', OWNER_UID, 'notes', 'note-1');

    await assertFails(deleteDoc(nonOwnerNote));
    await assertFails(deleteDoc(anonymousNote));
    await assertSucceeds(deleteDoc(ownerNote));
    expect((await getDoc(ownerNote)).exists()).toBe(false);
  });

  it('denies deleting a malformed Trash tombstone', async () => {
    await testEnvironment.withSecurityRulesDisabled(async (context) => {
      const malformedNote = doc(
        context.firestore(),
        'notes_users',
        OWNER_UID,
        'notes',
        'malformed-note',
      );
      await setDoc(malformedNote, {
        ...validNote('malformed-note'),
        deleted: true,
      });
    });

    const firestore = authorizedContext(testEnvironment).firestore();
    const malformedNote = doc(
      firestore,
      'notes_users',
      OWNER_UID,
      'notes',
      'malformed-note',
    );
    await assertFails(deleteDoc(malformedNote));
  });

  it('denies root documents and undeclared Notes subcollections', async () => {
    const firestore = authorizedContext(testEnvironment).firestore();
    const root = doc(firestore, 'notes_users', OWNER_UID);
    const privateDocument = doc(
      firestore,
      'notes_users',
      OWNER_UID,
      'uploads',
      'anything',
    );

    await assertFails(getDoc(root));
    await assertFails(setDoc(root, { email: TEST_EMAIL }));
    await assertFails(getDoc(privateDocument));
    await assertFails(setDoc(privateDocument, { value: 'not allowed' }));
  });

  it('keeps every existing shared-app namespace working for the owner', async () => {
    const firestore = authorizedContext(testEnvironment).firestore();
    const gymCore = doc(firestore, 'users', OWNER_UID, 'gym', 'core');
    const gymLog = doc(firestore, 'users', OWNER_UID, 'logs', '2026-08-07');
    const daymark = doc(firestore, 'daymark_users', OWNER_UID);
    const slateTask = doc(firestore, 'slate_users', OWNER_UID, 'tasks', 'task-1');
    const fareFood = doc(firestore, 'fare_users', OWNER_UID, 'foods', 'food-1');
    const researchNote = doc(firestore, 'research_users', OWNER_UID, 'notes', 'note-1');
    const recallSet = doc(firestore, 'recall_users', OWNER_UID, 'sets', 'set-1');

    await assertSucceeds(setDoc(gymCore, { schemaVersion: 1 }));
    await assertSucceeds(setDoc(gymLog, {
      schemaVersion: 1,
      date: '2026-08-07',
      deleted: false,
      updatedAt: '2026-08-07T12:00:00.000Z',
      updatedAtMs: 1,
      clientId: 'rules-test',
    }));
    await assertSucceeds(setDoc(daymark, {
      generationId: 'generation-1',
      profileGenerationId: 'generation-1',
    }));
    await assertSucceeds(setDoc(slateTask, { id: 'task-1', title: 'Regression check' }));
    await assertSucceeds(setDoc(fareFood, {
      id: 'food-1',
      name: 'Oats',
      updatedAt: '2026-07-21T12:00:00.000Z',
    }));
    await assertSucceeds(setDoc(researchNote, {
      id: 'note-1',
      createdAt: '2026-07-21T12:00:00.000Z',
      updatedAt: '2026-07-21T12:00:00.000Z',
      paperId: 'paper-1',
      body: 'Regression check',
      color: 'amber',
    }));
    await assertSucceeds(setDoc(recallSet, {
      id: 'set-1',
      title: 'Regression check',
      markdown: '# Recall',
      createdAt: 1,
      updatedAt: 1,
    }));

    await assertSucceeds(getDoc(gymCore));
    await assertSucceeds(getDoc(gymLog));
    await assertSucceeds(getDoc(daymark));
    await assertSucceeds(getDoc(slateTask));
    await assertSucceeds(getDoc(fareFood));
    await assertSucceeds(getDoc(researchNote));
    await assertSucceeds(getDoc(recallSet));
  });

  it('denies a non-owner across every existing shared-app namespace', async () => {
    const firestore = testEnvironment.authenticatedContext('attacker', {
      email: 'someone-else@example.com',
      email_verified: true,
      firebase: { sign_in_provider: 'google.com' },
    }).firestore();

    const attempts = [
      () => setDoc(doc(firestore, 'users', OWNER_UID, 'gym', 'core'), {
        schemaVersion: 1,
      }),
      () => setDoc(doc(firestore, 'users', OWNER_UID, 'logs', '2026-08-07'), {
        schemaVersion: 1,
        date: '2026-08-07',
        deleted: false,
        updatedAt: '2026-08-07T12:00:00.000Z',
        updatedAtMs: 1,
        clientId: 'rules-test',
      }),
      () => setDoc(doc(firestore, 'daymark_users', OWNER_UID), {
        generationId: 'generation-1',
        profileGenerationId: 'generation-1',
      }),
      () => setDoc(doc(firestore, 'slate_users', OWNER_UID, 'tasks', 'task-1'), {
        id: 'task-1',
        title: 'Denied',
      }),
      () => setDoc(doc(firestore, 'fare_users', OWNER_UID, 'foods', 'food-1'), {
        id: 'food-1',
        updatedAt: '2026-07-21T12:00:00.000Z',
      }),
      () => setDoc(doc(firestore, 'research_users', OWNER_UID, 'notes', 'note-1'), {
        id: 'note-1',
        createdAt: '2026-07-21T12:00:00.000Z',
        updatedAt: '2026-07-21T12:00:00.000Z',
        paperId: 'paper-1',
        body: 'Denied',
        color: 'amber',
      }),
      () => setDoc(doc(firestore, 'recall_users', OWNER_UID, 'sets', 'set-1'), {
        id: 'set-1',
        title: 'Denied',
        markdown: '# Denied',
        createdAt: 1,
        updatedAt: 1,
      }),
    ];

    for (const attempt of attempts) await assertFails(attempt());
  });
});
