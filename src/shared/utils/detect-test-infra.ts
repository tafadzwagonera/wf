import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildSkipDirs, walkDir } from './walk-dir';
import type { PackageManager } from './detect-repo-conventions';
import { formatRunnerInvocation } from './verification-commands';
import type {
  DiSetupPattern,
  NodeFramework,
  NodeInfra,
  TerraformInfra,
  PythonInfra,
  GoInfra,
  EcosystemInfra,
  TestInfraContext,
} from '../types/detection.types';

export type { Ecosystem, EcosystemInfra, NodeInfra, TerraformInfra, PythonInfra, GoInfra, TestInfraContext } from '../types/detection.types';

const NODE_FRAMEWORKS: NodeFramework[] = ['jest', 'vitest', 'mocha', 'tap', 'ava'];

const RELEVANT_SCRIPT_PATTERN = /^test|^lint$|^typecheck$|^build$|^check$/;

/**
 * Parse the major Node.js version from a version string, `.nvmrc`, or `.node-version` content.
 *
 * @param raw - Raw version text (e.g., "22", "v22.17.1", "lts/*")
 * @returns Major version number, or null when unparseable
 */
const parseNodeMajor = (raw: string): number | null => {
  const trimmed = raw.trim().replace(/^v/i, '');
  const match = /(\d+)/.exec(trimmed);
  return match ? Number.parseInt(match[1], 10) : null;
};

/**
 * Attempt to read a file synchronously, returning null when unavailable.
 */
const readFileOrNull = (filePath: string): string | null => {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
};

const TEST_FILE_PATTERN = /\.(spec|test)\.(ts|tsx|js|jsx)$/;
const CLEANUP_CALL_PATTERN = /(\w+)\.(restoreAllMocks|resetAllMocks|clearAllMocks)\(\)/g;
const HELPER_PATTERNS = [/test-utils/, /test-helper/, /__mocks__/, /fixtures/, /test-setup/];
const CLEANUP_METHODS = ['restoreAllMocks', 'resetAllMocks', 'clearAllMocks'] as const;

const readTestFiles = (testFiles: string[]): Map<string, string> => {
  const contents = new Map<string, string>();
  for (const f of testFiles) {
    contents.set(f, readFileOrNull(f) ?? '');
  }
  return contents;
};

const detectFileSuffix = (testFiles: string[]): '.spec' | '.test' | 'mixed' => {
  let specCount = 0;
  for (const f of testFiles) {
    if (/\.spec\./.test(f)) specCount++;
  }
  const ratio = specCount / testFiles.length;
  if (ratio >= 0.8) return '.spec';
  if ((testFiles.length - specCount) / testFiles.length >= 0.8) return '.test';
  return 'mixed';
};

const scanContentPatterns = (contents: Map<string, string>) => {
  let mockPrefix: string | null = null;
  let mockFactoryPrefix: string | null = null;
  let nestedCount = 0;
  let diSetupPattern: DiSetupPattern = null;
  for (const [, content] of contents) {
    if (mockPrefix === null && /const mock[A-Z]/.test(content)) mockPrefix = 'mock';
    if (mockFactoryPrefix === null && /(?:const|function)\s+createMock[A-Z]/.test(content)) mockFactoryPrefix = 'createMock';
    const matches = content.match(/describe\s*\(/g);
    if (matches && matches.length >= 2) nestedCount++;
    if (diSetupPattern === null && /Test\.createTestingModule/.test(content)) diSetupPattern = 'testing-module';
  }
  const describeStyle: 'flat' | 'nested' = nestedCount > contents.size / 2 ? 'nested' : 'flat';
  return { mockPrefix, mockFactoryPrefix, describeStyle, diSetupPattern };
};

const scanFileCleanupCalls = (
  file: string, content: string,
  acc: { counts: Record<string, number>; files: Set<string>; namespaces: Record<string, number> },
): void => {
  const seenMethods = new Set<string>();
  for (const [, namespace, method] of content.matchAll(new RegExp(CLEANUP_CALL_PATTERN.source, 'g'))) {
    if (!seenMethods.has(method)) {
      acc.counts[method]++;
      seenMethods.add(method);
    }
    acc.namespaces[namespace] = (acc.namespaces[namespace] ?? 0) + 1;
    acc.files.add(file);
  }
};

const scanCleanupPatterns = (contents: Map<string, string>) => {
  const acc = {
    counts: { restoreAllMocks: 0, resetAllMocks: 0, clearAllMocks: 0 } as Record<string, number>,
    files: new Set<string>(),
    namespaces: {} as Record<string, number>,
  };
  for (const [file, content] of contents) scanFileCleanupCalls(file, content, acc);
  return { cleanupCounts: acc.counts, filesWithCleanup: acc.files, namespaceCounts: acc.namespaces };
};

const resolveMockCleanup = (
  cleanup: ReturnType<typeof scanCleanupPatterns>,
): { namespace: string; method: (typeof CLEANUP_METHODS)[number] } | null => {
  if (cleanup.filesWithCleanup.size === 0) return null;
  const threshold = cleanup.filesWithCleanup.size * 0.5;
  const dominantMethod = CLEANUP_METHODS.find(m => cleanup.cleanupCounts[m] >= threshold) ?? null;
  if (!dominantMethod) return null;
  const dominantNamespace = Object.entries(cleanup.namespaceCounts).sort(([, a], [, b]) => b - a)[0][0];
  return { namespace: dominantNamespace, method: dominantMethod };
};

const resolveDiSetupPattern = (
  contents: Map<string, string>,
  initial: DiSetupPattern,
): DiSetupPattern => {
  if (initial !== null) return initial;
  for (const [, content] of contents) {
    if (/buildCommand\(|buildAgent\(/.test(content)) return 'factory-function';
  }
  return null;
};

const detectErrorHandlerExits = (repoDir: string, skipDirs: Set<string>): boolean => {
  const srcDir = path.join(repoDir, 'src');
  if (!fs.existsSync(srcDir)) return false;
  const srcFiles = walkDir(srcDir, () => true, skipDirs).filter(f => /\.(ts|tsx|js|jsx)$/.test(f));
  for (const f of srcFiles) {
    const content = readFileOrNull(f) ?? '';
    if (/handle\s*\(/.test(content) && /process\.exit\(1\)/.test(content)) return true;
  }
  return false;
};

const detectHelperPaths = (repoDir: string, skipDirs: Set<string>): string[] =>
  walkDir(repoDir, f => HELPER_PATTERNS.some(p => p.test(f)), skipDirs)
    .slice(0, 10)
    .map(f => path.relative(repoDir, f));

const assembleTestPatterns = (
  testFiles: string[], contents: Map<string, string>, repoDir: string, skipDirs: Set<string>,
): NonNullable<NodeInfra['testPatterns']> => {
  const patterns = scanContentPatterns(contents);
  const cleanup = scanCleanupPatterns(contents);
  return {
    ...patterns,
    fileSuffix: detectFileSuffix(testFiles),
    helperPaths: detectHelperPaths(repoDir, skipDirs),
    mockCleanup: resolveMockCleanup(cleanup),
    diSetupPattern: resolveDiSetupPattern(contents, patterns.diSetupPattern),
    errorHandlerExits: detectErrorHandlerExits(repoDir, skipDirs),
  };
};

/**
 * Scan up to 20 test files in repoDir to detect project-level test conventions.
 *
 * @param repoDir - Absolute path to the repository root
 * @returns Detected test pattern data, or undefined when no test files are found
 */
const detectTestPatterns = (repoDir: string): NodeInfra['testPatterns'] => {
  const skipDirs = buildSkipDirs(repoDir);
  const scanRoot = fs.existsSync(path.join(repoDir, 'src')) ? path.join(repoDir, 'src') : repoDir;
  const testFiles = walkDir(scanRoot, f => TEST_FILE_PATTERN.test(f), skipDirs).slice(0, 20);
  if (testFiles.length === 0) return undefined;
  return assembleTestPatterns(testFiles, readTestFiles(testFiles), repoDir, skipDirs);
};

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: { node?: string };
}

const parseNodeVersionFromPipelines = (repoDir: string): number | null => {
  const pipelines = readFileOrNull(path.join(repoDir, 'bitbucket-pipelines.yml'));
  if (!pipelines) return null;
  const imageMatch = /image:\s*node:(\d+)/.exec(pipelines);
  return imageMatch ? Number.parseInt(imageMatch[1], 10) : null;
};

const resolveNodeVersion = (repoDir: string, engines: { node?: string } | undefined): number | null => {
  const candidates = [
    engines?.node,
    readFileOrNull(path.join(repoDir, '.nvmrc')),
    readFileOrNull(path.join(repoDir, '.node-version')),
  ];
  for (const candidate of candidates) {
    if (candidate) {
      const version = parseNodeMajor(candidate);
      if (version !== null) return version;
    }
  }
  return parseNodeVersionFromPipelines(repoDir);
};

const filterRelevantScripts = (scripts: Record<string, string>): Record<string, string> => {
  const relevant: Record<string, string> = {};
  for (const [name, value] of Object.entries(scripts)) {
    if (RELEVANT_SCRIPT_PATTERN.test(name)) relevant[name] = value;
  }
  return relevant;
};

const buildNodeInfra = (pkg: PackageJson, repoDir: string, nodeVersionMajor: number | null): NodeInfra => {
  const allScripts = pkg.scripts ?? {};
  return {
    ecosystem: 'node',
    nodeVersionMajor,
    hasNodeTest: nodeVersionMajor !== null && nodeVersionMajor >= 18,
    frameworks: NODE_FRAMEWORKS.filter(fw => fw in { ...pkg.dependencies, ...pkg.devDependencies }),
    scripts: filterRelevantScripts(allScripts),
    allScriptNames: Object.keys(allScripts),
    testPatterns: detectTestPatterns(repoDir),
  };
};

/**
 * Detect Node.js test infrastructure from a repository directory.
 */
const detectNode = (repoDir: string): NodeInfra | null => {
  const raw = readFileOrNull(path.join(repoDir, 'package.json'));
  if (!raw) return null;
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return null;
  }
  return buildNodeInfra(pkg, repoDir, resolveNodeVersion(repoDir, pkg.engines));
};

/**
 * Detect Terraform infrastructure from a repository directory.
 */
// eslint-disable-next-line max-lines-per-function
const detectTerraform = (repoDir: string): TerraformInfra | null => {
  let entries: string[];
  try {
    entries = fs.readdirSync(repoDir);
  } catch {
    return null;
  }

  const tfFiles = entries.filter(name => name.endsWith('.tf'));
  if (tfFiles.length === 0) return null;

  let hasBackendConfig = false;
  for (const tfFile of tfFiles) {
    const content = readFileOrNull(path.join(repoDir, tfFile));
    if (content && /backend\s+"/.test(content)) {
      hasBackendConfig = true;
      break;
    }
  }

  return { ecosystem: 'terraform', hasTfFiles: true, hasBackendConfig };
};

/**
 * Detect Python test infrastructure from a repository directory.
 */
// eslint-disable-next-line max-lines-per-function
const detectPython = (repoDir: string): PythonInfra | null => {
  const hasSetupPy = fs.existsSync(path.join(repoDir, 'setup.py'));
  const hasPyproject = fs.existsSync(path.join(repoDir, 'pyproject.toml'));
  const hasRequirementsTxt = fs.existsSync(path.join(repoDir, 'requirements.txt'));

  if (!hasSetupPy && !hasPyproject && !hasRequirementsTxt) return null;

  const frameworks: PythonInfra['frameworks'] = [];
  const depsFiles = [
    readFileOrNull(path.join(repoDir, 'requirements.txt')),
    readFileOrNull(path.join(repoDir, 'pyproject.toml')),
  ].filter(Boolean);

  const depsText = depsFiles.join('\n');
  if (/\bpytest\b/.test(depsText)) frameworks.push('pytest');
  if (/\bunittest\b/.test(depsText)) frameworks.push('unittest');
  if (/\btox\b/.test(depsText)) frameworks.push('tox');
  if (/\bnox\b/.test(depsText)) frameworks.push('nox');

  return { ecosystem: 'python', frameworks, hasRequirementsTxt };
};

/**
 * Detect Go infrastructure from a repository directory.
 */
const detectGo = (repoDir: string): GoInfra | null => {
  if (!fs.existsSync(path.join(repoDir, 'go.mod'))) return null;
  return { ecosystem: 'go', hasGoMod: true };
};

/**
 * Detect available test infrastructure in a target repository directory.
 *
 * @param repoDir - Absolute path to the repository root
 * @returns Detected ecosystems and the primary ecosystem
 */
const detectTestInfra = (repoDir: string): TestInfraContext => {
  const detectors: Array<(dir: string) => EcosystemInfra | null> = [
    detectNode,
    detectTerraform,
    detectPython,
    detectGo,
  ];

  const ecosystems: EcosystemInfra[] = [];
  for (const detect of detectors) {
    const result = detect(repoDir);
    if (result) ecosystems.push(result);
  }

  const primary = ecosystems.length > 0 ? ecosystems[0].ecosystem : 'node';

  return { ecosystems, primary };
};

const formatMockNamingLine = (p: NonNullable<NodeInfra['testPatterns']>): string[] => {
  if (!p.mockPrefix) return [];
  const factoryNote = p.mockFactoryPrefix
    ? `; factories use "${p.mockFactoryPrefix}" (e.g., ${p.mockFactoryPrefix}User)`
    : '';
  return [`- Mock naming: prefix mocks with "${p.mockPrefix}" (e.g., ${p.mockPrefix}User)${factoryNote}`];
};

const formatMockCleanupLine = (
  cleanup: { namespace: string; method: string } | null,
): string[] =>
  cleanup
    ? [`- Mock isolation: always prescribe \`${cleanup.namespace}.${cleanup.method}()\` in afterEach() — do NOT leave cleanup steps as conditional; prescribe the exact call`]
    : [];

const formatDiSetupLines = (pattern: DiSetupPattern): string[] => {
  switch (pattern) {
    case 'testing-module':
      return ['- DI test setup: tests use a testing-module pattern (e.g., Test.createTestingModule). State which DI framework you assume so the implementer can verify.'];
    case 'factory-function':
      return ['- DI test setup: tests use factory helpers to construct the unit under test. State which factory you assume so the implementer can verify.'];
    default: return [];
  }
};

const formatErrorHandlerLines = (exits: boolean): string[] =>
  exits
    ? ['- Error handler: ErrorHandler.handle() calls process.exit(1) — tests MUST mock process.exit before invoking code that reaches this handler; rejects.toThrow() alone will not work']
    : [];

const formatTestPatternLines = (p: NonNullable<NodeInfra['testPatterns']>): string[] => {
  const suffix = p.fileSuffix === 'mixed' ? '*.spec.ts / *.test.ts' : `*${p.fileSuffix}.ts`;
  return [
    `- Test file suffix: ${suffix} (use this suffix for new test files)`,
    ...formatMockNamingLine(p),
    `- Test structure: ${p.describeStyle === 'nested' ? 'nested' : 'flat'} describe blocks`,
    ...(p.helperPaths.length > 0 ? [`- Test helpers: ${p.helperPaths.join(', ')}`] : []),
    ...formatMockCleanupLine(p.mockCleanup),
    ...formatDiSetupLines(p.diSetupPattern),
    ...formatErrorHandlerLines(p.errorHandlerExits),
    'Follow these patterns when prescribing test changes.',
  ];
};

const formatNodeEcoLines = (eco: NodeInfra): string[] => {
  const version = eco.nodeVersionMajor === null ? 'unknown' : `v${eco.nodeVersionMajor}`;
  const nodeTest = eco.hasNodeTest ? ' (node:test and node:assert available)' : '';
  const scripts = Object.entries(eco.scripts).map(([n, c]) => `${n} ("${c}")`).join(', ');
  return [
    `- Node.js: ${version}${nodeTest}`,
    ...(eco.frameworks.length > 0 ? [`- Frameworks: ${eco.frameworks.join(', ')}`] : []),
    ...(scripts ? [`- Scripts: ${scripts}`] : []),
    ...(eco.testPatterns
      ? ['', 'Test conventions detected in this repository:', ...formatTestPatternLines(eco.testPatterns)]
      : []),
  ];
};

const formatTerraformEcoLines = (eco: TerraformInfra): string[] => {
  const backendNote = eco.hasBackendConfig ? ' with backend configuration' : '';
  return [
    `- Terraform files detected${backendNote}`,
    '- Available commands: terraform validate, terraform plan, terraform fmt -check <file.tf ...>',
  ];
};

const formatPythonEcoLines = (eco: PythonInfra): string[] => [
  '- Python project detected',
  ...(eco.frameworks.length > 0 ? [`- Frameworks: ${eco.frameworks.join(', ')}`] : []),
];

const formatEcosystemLines = (eco: EcosystemInfra): string[] => {
  switch (eco.ecosystem) {
    case 'node': return formatNodeEcoLines(eco);
    case 'terraform': return formatTerraformEcoLines(eco);
    case 'python': return formatPythonEcoLines(eco);
    case 'go': return ['- Go module detected', '- Available commands: go test ./..., go vet ./...'];
  }
};

const buildNodeVerificationRules = (packageManager: PackageManager): string[] => [
  `- Prefer existing scripts with a filter (e.g., "${formatRunnerInvocation(packageManager, 'test', 'pricing/pricing.spec.ts')}") over bare "${formatRunnerInvocation(packageManager, 'test')}".`,
  "- When no matching script exists, prefer inline: node -e \"const assert = require('node:assert'); ...\"",
  '- Verification commands MUST be shell-safe by construction. For inline `node -e`, prefer single-quoted JS strings or properly escaped backticks — never rely on unescaped template literals inside double-quoted shell strings.',
];

const TERRAFORM_VERIFICATION_RULES: string[] = [
  '- Use "terraform validate" for syntax/config checks, "terraform plan" for drift detection.',
  '- Prefer targeted: "terraform plan -target=module.foo" over bare "terraform plan".',
  '- "terraform fmt" must use -check and list the affected .tf files explicitly (e.g. "terraform fmt -check main.tf variables.tf") — never bare, never -recursive.',
];

const formatAllowedCommandForms = (eco: NodeInfra, packageManager: PackageManager): string[] => [
  '',
  'Allowed verification command forms (exhaustive — do NOT use unlisted commands):',
  '- node -e "..."',
  '- sh -c "..." / bash -c "..."',
  ...Object.entries(eco.scripts).map(
    ([name, cmd]) => `- ${formatRunnerInvocation(packageManager, name, '...')} (runs: "${cmd}")`,
  ),
];

const formatVerificationRules = (ctx: TestInfraContext, packageManager: PackageManager): string[] => {
  const nodeEco = ctx.ecosystems.find((e): e is NodeInfra => e.ecosystem === 'node');
  const tfEco = ctx.ecosystems.find((e): e is TerraformInfra => e.ecosystem === 'terraform');
  return [
    'Rules for verification commands:',
    '- Reference ONLY the scripts and binaries listed above. Do not invent scripts.',
    '- Each command must verify a specific side effect of THIS plan — not run a generic suite.',
    ...(nodeEco ? buildNodeVerificationRules(packageManager) : []),
    ...(tfEco ? TERRAFORM_VERIFICATION_RULES : []),
    '- Every command must be copy-paste-runnable from the repo root.',
    ...(nodeEco ? formatAllowedCommandForms(nodeEco, packageManager) : []),
  ];
};

/**
 * Format a prompt section describing the detected test infrastructure.
 *
 * @param ctx - Test infrastructure context from `detectTestInfra()`
 * @returns Multi-line string for injection into AI prompts
 */
const formatTestInfraPromptSection = (ctx: TestInfraContext, packageManager: PackageManager = 'npm'): string => {
  if (ctx.ecosystems.length === 0) return 'No test infrastructure detected — use only POSIX shell commands.';
  return [
    'Available test infrastructure in this repository:',
    `Ecosystems detected: ${ctx.ecosystems.map(e => e.ecosystem).join(', ')} (primary: ${ctx.primary})`,
    ...ctx.ecosystems.flatMap(formatEcosystemLines),
    ...formatVerificationRules(ctx, packageManager),
  ].join('\n');
};

export { detectTestInfra, detectTestPatterns, formatTestInfraPromptSection };
