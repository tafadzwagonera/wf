#!/usr/bin/env ts-node
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline/promises';

interface KeyProfile {
  defaultComment: string;
  file: string;
  host: string;
  hostName: string;
  label: string;
  registerAt: string;
  successPattern: RegExp;
}

const repoRoot = path.resolve(__dirname, '..');
const sshDir = path.join(os.homedir(), '.ssh');
const sshConfigPath = path.join(sshDir, 'config');
const expectedOriginUrl = 'git@github.com-personal:tafadzwagonera/wf.git';
const isMacOs = process.platform === 'darwin';

const keyProfiles: KeyProfile[] = [
  {
    defaultComment: 'personal@email.com',
    file: 'id_ed25519_personal',
    host: 'github.com-personal',
    hostName: 'github.com',
    label: 'personal (GitHub)',
    registerAt: 'GitHub → Settings → SSH and GPG keys → New SSH key',
    successPattern: /successfully authenticated/i,
  },
  {
    defaultComment: 'work@email.com',
    file: 'id_ed25519_work',
    host: 'bitbucket.org-work',
    hostName: 'bitbucket.org',
    label: 'work (Bitbucket)',
    registerAt: 'Bitbucket → Personal Settings → SSH keys → Add key',
    successPattern: /logged in as|authenticated via/i,
  },
];

const keyPath = (profile: KeyProfile): string => path.join(sshDir, profile.file);

const runInteractive = (command: string, args: string[]): void => {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with status ${result.status ?? 'unknown'}`);
  }
};

const generateKey = async (rl: readline.Interface, profile: KeyProfile): Promise<void> => {
  if (fs.existsSync(keyPath(profile))) {
    console.log(`ok ${profile.file} already exists`);
    return;
  }
  const answer = await rl.question(`Email comment for the ${profile.label} key [${profile.defaultComment}]: `);
  const comment = answer.trim() || profile.defaultComment;
  runInteractive('ssh-keygen', ['-t', 'ed25519', '-C', comment, '-f', keyPath(profile)]);
};

const addKeyToAgent = (profile: KeyProfile): void => {
  const args = isMacOs ? ['--apple-use-keychain', keyPath(profile)] : [keyPath(profile)];
  runInteractive('ssh-add', args);
};

const buildSshConfigBlock = (profile: KeyProfile): string => {
  const lines = [
    `Host ${profile.host}`,
    `  HostName ${profile.hostName}`,
    '  User git',
    `  IdentityFile ~/.ssh/${profile.file}`,
    '  AddKeysToAgent yes',
  ];
  if (isMacOs) lines.push('  UseKeychain yes');
  return lines.join('\n');
};

const blockSeparator = (existing: string): string => {
  if (existing === '') return '';
  return existing.endsWith('\n') ? '\n' : '\n\n';
};

const ensureSshConfigBlock = (profile: KeyProfile): void => {
  const existing = fs.existsSync(sshConfigPath) ? fs.readFileSync(sshConfigPath, 'utf8') : '';
  if (existing.includes(`Host ${profile.host}`)) {
    console.log(`ok ssh config already has Host ${profile.host}`);
    return;
  }
  const content = `${existing}${blockSeparator(existing)}${buildSshConfigBlock(profile)}\n`;
  fs.writeFileSync(sshConfigPath, content, { mode: 0o600 });
  console.log(`added Host ${profile.host} to ${sshConfigPath}`);
};

const resolveClipboardCommand = (): string[] | undefined => {
  const candidates = isMacOs ? [['pbcopy']] : [['wl-copy'], ['xclip', '-selection', 'clipboard']];
  return candidates.find(([command]) => spawnSync('which', [command], { stdio: 'ignore' }).status === 0);
};

const copyToClipboard = (content: string): boolean => {
  const command = resolveClipboardCommand();
  if (!command) return false;
  execFileSync(command[0], command.slice(1), { input: content });
  return true;
};

const registerPublicKey = async (rl: readline.Interface, profile: KeyProfile): Promise<void> => {
  const publicKey = fs.readFileSync(`${keyPath(profile)}.pub`, 'utf8').trim();
  const clipboardNote = copyToClipboard(publicKey) ? 'copied to clipboard' : 'no clipboard tool found, copy it manually';
  console.log(`\n${profile.label} public key (${clipboardNote}):\n${publicKey}\n`);
  await rl.question(`Register it at ${profile.registerAt}, then press Enter (press Enter directly if already registered)... `);
};

const verifySshConnection = (profile: KeyProfile): void => {
  const result = spawnSync('ssh', ['-T', '-o', 'StrictHostKeyChecking=accept-new', `git@${profile.host}`], {
    encoding: 'utf8',
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (!profile.successPattern.test(output)) {
    throw new Error(`SSH verification failed for git@${profile.host}:\n${output}`);
  }
  console.log(`ok git@${profile.host}: ${output.split('\n')[0]}`);
};

const updateWfOrigin = (): void => {
  const current = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot }).toString().trim();
  if (current === expectedOriginUrl) {
    console.log('ok origin already uses github.com-personal');
    return;
  }
  execFileSync('git', ['remote', 'set-url', 'origin', expectedOriginUrl], { cwd: repoRoot });
  console.log(`updated origin: ${current} → ${expectedOriginUrl}`);
};

const verifyGitIdentity = (): void => {
  const lastAuthorEmail = execFileSync('git', ['log', '--format=%ae', '-1'], { cwd: repoRoot }).toString().trim();
  console.log(`last commit author email: ${lastAuthorEmail}`);
  runInteractive('git', ['-C', repoRoot, 'push', 'origin', 'HEAD', '--dry-run']);
  console.log('ok push dry-run succeeded');
};

const setUpKeys = async (): Promise<void> => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const profile of keyProfiles) {
      await generateKey(rl, profile);
      addKeyToAgent(profile);
      ensureSshConfigBlock(profile);
      await registerPublicKey(rl, profile);
    }
  } finally {
    rl.close();
  }
};

const assertSupportedPlatform = (): void => {
  if (!isMacOs && process.platform !== 'linux') {
    throw new Error(`Unsupported platform "${process.platform}": this setup supports macOS and Linux only.`);
  }
  if (!isMacOs && !process.env.SSH_AUTH_SOCK) {
    throw new Error('No ssh-agent detected (SSH_AUTH_SOCK is unset). Start one with: eval "$(ssh-agent -s)", then re-run.');
  }
};

const main = async (): Promise<void> => {
  assertSupportedPlatform();
  fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  await setUpKeys();
  for (const profile of keyProfiles) {
    verifySshConnection(profile);
  }
  updateWfOrigin();
  verifyGitIdentity();
  console.log('SSH multi-account setup complete.');
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
