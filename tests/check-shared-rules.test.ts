import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// The parity check has to stay honest inside a GitHub Actions checkout, which
// contains this repository and nothing else. These cases build throwaway
// workspaces around a copy of the real script so the single-repository shape
// can be exercised without any sibling repository on disk.

const SCRIPT = resolve(process.cwd(), 'scripts/check-shared-rules.mjs');
const SIBLINGS = ['gym', 'daymark', 'fare', 'slate', 'research', 'degree', 'studies', 'radar'];
const RULES = 'rules_version = "2";\nservice cloud.firestore {\n}\n';

const workspaces: string[] = [];

function digestOf(rules: string) {
  return createHash('sha256').update(Buffer.from(rules)).digest('hex');
}

interface WorkspaceOptions {
  rules?: string;
  digest?: string;
  siblings?: string[];
  siblingRules?: Record<string, string>;
  siblingsWithoutRules?: string[];
}

function buildWorkspace(options: WorkspaceOptions = {}) {
  const rules = options.rules ?? RULES;
  const root = mkdtempSync(resolve(tmpdir(), 'notes-rules-parity-'));
  workspaces.push(root);

  const repository = resolve(root, 'notes');
  mkdirSync(resolve(repository, 'scripts'), { recursive: true });
  copyFileSync(SCRIPT, resolve(repository, 'scripts/check-shared-rules.mjs'));
  writeFileSync(resolve(repository, 'firestore.rules'), rules);
  writeFileSync(
    resolve(repository, 'shared-firestore-rules.sha256'),
    `${options.digest ?? digestOf(rules)}\n`,
  );

  for (const name of options.siblings ?? []) {
    mkdirSync(resolve(root, name), { recursive: true });
    writeFileSync(
      resolve(root, name, 'firestore.rules'),
      options.siblingRules?.[name] ?? rules,
    );
  }
  for (const name of options.siblingsWithoutRules ?? []) {
    mkdirSync(resolve(root, name), { recursive: true });
  }

  return repository;
}

function runCheck(options: WorkspaceOptions = {}) {
  const repository = buildWorkspace(options);
  const result = spawnSync(
    process.execPath,
    [resolve(repository, 'scripts/check-shared-rules.mjs')],
    { encoding: 'utf8' },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

afterEach(() => {
  while (workspaces.length) rmSync(workspaces.pop() as string, { recursive: true, force: true });
});

describe('shared Firestore rules parity check', () => {
  it('verifies the recorded digest when no sibling repository is checked out', () => {
    const { status, stdout } = runCheck();

    expect(status).toBe(0);
    expect(stdout).toContain('verified against the recorded digest');
    // It must not imply it compared anything it could not see.
    expect(stdout).toContain('NOT compared');
    expect(stdout).not.toMatch(/match across|byte-identical copies/);
  });

  it('fails in a single-repository checkout when the rules no longer match the digest', () => {
    const { status, stderr } = runCheck({ digest: digestOf('rules_version = "2";\n') });

    expect(status).toBe(1);
    expect(stderr).toContain('does not match the reviewed shared ruleset');
  });

  it('fails when only some sibling repositories are checked out', () => {
    const { status, stdout, stderr } = runCheck({ siblings: ['gym', 'daymark'] });

    expect(status).toBe(1);
    expect(stderr).toContain('only 2 of 8 sibling repositories are checked out');
    expect(stderr).toContain('fare, slate, research, degree, studies, radar');
    expect(stdout).toBe('');
  });

  it('fails when a sibling repository is missing the shared ruleset', () => {
    const { status, stderr } = runCheck({
      siblings: SIBLINGS.filter((name) => name !== 'slate'),
      siblingsWithoutRules: ['slate'],
    });

    expect(status).toBe(1);
    expect(stderr).toContain('have no firestore.rules');
    expect(stderr).toContain('slate');
  });

  it('fails when a sibling ruleset has drifted', () => {
    const { status, stderr } = runCheck({
      siblings: SIBLINGS,
      siblingRules: { research: `${RULES}// drift\n` },
    });

    expect(status).toBe(1);
    expect(stderr).toContain('differ from the canonical Notes copy');
    expect(stderr).toContain('research');
  });

  it('reports a full comparison only when every sibling repository matched', () => {
    const { status, stdout } = runCheck({ siblings: SIBLINGS });

    expect(status).toBe(0);
    expect(stdout).toContain('byte-identical copies in all 8 sibling repositories');
  });

  it('fails when the recorded digest is missing or malformed', () => {
    const { status, stderr } = runCheck({ digest: 'not-a-digest' });

    expect(status).toBe(1);
    expect(stderr).toContain('does not contain a sha256 digest');
  });
});
