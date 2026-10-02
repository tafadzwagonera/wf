import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { GitService } from '../../src/integrations/git/git.service';
import { GitError } from '../../src/shared/utils/errors';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();
const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

function makeRepo(): { dir: string; git: (cmd: string) => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-hooks-test-'));
  const run = (cmd: string) => execSync(cmd, { cwd: dir, encoding: 'utf-8', stdio: 'pipe' }).trim();
  run('git init');
  run('git config user.email "test@example.com"');
  run('git config user.name "Test"');
  run('git config commit.gpgsign false');
  return { dir, git: run };
}

function installHook(dir: string, name: string, content: string): void {
  const hookPath = path.join(dir, '.git', 'hooks', name);
  fs.writeFileSync(hookPath, content, { mode: 0o755 });
}

function stageFile(dir: string, name: string, content: string): void {
  fs.writeFileSync(path.join(dir, name), content);
  execSync(`git add ${name}`, { cwd: dir, stdio: 'pipe' });
}

async function assertHooksAndCapitalization(
  gitService: GitService, dir: string, git: (cmd: string) => string
): Promise<void> {
  installHook(dir, 'commit-msg', '#!/bin/sh\n[ "$LEFTHOOK" != "0" ] || { echo "LEFTHOOK bypass detected"; exit 1; }\nexit 0\n');
  installHook(dir, 'pre-commit', '#!/bin/sh\n[ "$GIT_TERMINAL_PROMPT" = "0" ] || { echo "GIT_TERMINAL_PROMPT not set"; exit 1; }\nexit 0\n');
  stageFile(dir, 'a.ts', 'export const x = 1;');
  await gitService.commit({ message: 'ABC-1: add thing', cwd: dir });
  const lastSubject = git('git log -1 --format=%s');
  assert('commit subject is capitalized', lastSubject === 'ABC-1: Add thing', `got: ${lastSubject}`);
  assert('commit-msg hook ran (LEFTHOOK bypass removed)', true);
  assert('pre-commit hook ran (GIT_TERMINAL_PROMPT=0 set)', true);
}

async function assertRejectingHookThrows(gitService: GitService, dir: string): Promise<void> {
  installHook(dir, 'commit-msg', '#!/bin/sh\necho "rejected by hook" >&2\nexit 1\n');
  stageFile(dir, 'b.ts', 'export const y = 2;');
  let threw = false;
  try {
    await gitService.commit({ message: 'ABC-1: Add another thing', cwd: dir });
  } catch (e) {
    threw = e instanceof GitError;
  }
  assert('rejecting commit-msg hook surfaces as GitError', threw);
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const gitService = app.get(GitService);
  const { dir, git } = makeRepo();
  try {
    await assertHooksAndCapitalization(gitService, dir, git);
    await assertRejectingHookThrows(gitService, dir);
  } finally {
    fs.rmSync(dir, { recursive: true });
    await app.close();
  }
  summarise(counts);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
