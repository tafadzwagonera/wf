import * as fs from 'fs';
import * as path from 'path';
import { buildSkipDirs, walkDir } from './walk-dir';
import type {
  Ecosystem,
  NodeFramework,
  NodeInfra,
  TerraformInfra,
  PythonInfra,
  GoInfra,
  EcosystemInfra,
  TestInfraContext,
} from '../types/detection.types';

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
  return match ? parseInt(match[1], 10) : null;
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
const HELPER_PATTERNS = [/test-utils/, /test-helper/, /__mocks__/, /fixtures/, /test-setup/];

/**
 * Scan up to 20 test files in repoDir to detect project-level test conventions.
 *
 * @param repoDir - Absolute path to the repository root
 * @returns Detected test pattern data, or undefined when no test files are found
 */
const detectTestPatterns = (repoDir: string): NodeInfra['testPatterns'] => {
  const scanRoot = fs.existsSync(path.join(repoDir, 'src')) ? path.join(repoDir, 'src') : repoDir;
  const skipDirs = buildSkipDirs(repoDir);

  const allFiles = walkDir(scanRoot, f => TEST_FILE_PATTERN.test(f), skipDirs);
  const testFiles = allFiles.slice(0, 20);

  if (testFiles.length === 0) return undefined;

  // fileSuffix
  let specCount = 0;
  let testCount = 0;
  for (const f of testFiles) {
    if (/\.spec\./.test(f)) specCount++;
    else testCount++;
  }
  const total = testFiles.length;
  let fileSuffix: '.spec' | '.test' | 'mixed' = 'mixed';
  if (specCount / total >= 0.8) fileSuffix = '.spec';
  else if (testCount / total >= 0.8) fileSuffix = '.test';

  // Single-pass content scan: mockPrefix, mockFactoryPrefix, describeStyle, mockCleanup, diSetupPattern
  let mockPrefix: string | null = null;
  let mockFactoryPrefix: string | null = null;
  let nestedCount = 0;
  let diSetupPattern: 'testing-module' | 'factory-function' | null = null;
  const cleanupCounts: Record<string, number> = { restoreAllMocks: 0, resetAllMocks: 0, clearAllMocks: 0 };
  const filesWithCleanup = new Set<string>();
  const contentCache = new Map<string, string>();

  for (const f of testFiles) {
    const content = (() => {
      try {
        return fs.readFileSync(f, 'utf-8');
      } catch {
        return '';
      }
    })();
    contentCache.set(f, content);

    if (mockPrefix === null && /const mock[A-Z]/.test(content)) mockPrefix = 'mock';
    if (mockFactoryPrefix === null && /(?:const|function)\s+createMock[A-Z]/.test(content)) {
      mockFactoryPrefix = 'createMock';
    }
    const matches = content.match(/describe\s*\(/g);
    if (matches && matches.length >= 2) nestedCount++;

    // mockCleanup detection
    if (/jest\.restoreAllMocks\(\)/.test(content)) {
      cleanupCounts.restoreAllMocks++;
      filesWithCleanup.add(f);
    }
    if (/jest\.resetAllMocks\(\)/.test(content)) {
      cleanupCounts.resetAllMocks++;
      filesWithCleanup.add(f);
    }
    if (/jest\.clearAllMocks\(\)/.test(content)) {
      cleanupCounts.clearAllMocks++;
      filesWithCleanup.add(f);
    }

    // diSetupPattern detection
    if (diSetupPattern === null && /Test\.createTestingModule/.test(content)) {
      diSetupPattern = 'testing-module';
    }
  }

  const describeStyle: 'flat' | 'nested' = nestedCount > testFiles.length / 2 ? 'nested' : 'flat';

  // Determine mockCleanup: whichever variant appears in >= 50% of unique files with any cleanup wins
  let mockCleanup: 'restoreAllMocks' | 'resetAllMocks' | 'clearAllMocks' | null = null;
  if (filesWithCleanup.size > 0) {
    const threshold = filesWithCleanup.size * 0.5;
    if (cleanupCounts.restoreAllMocks >= threshold) mockCleanup = 'restoreAllMocks';
    else if (cleanupCounts.resetAllMocks >= threshold) mockCleanup = 'resetAllMocks';
    else if (cleanupCounts.clearAllMocks >= threshold) mockCleanup = 'clearAllMocks';
  }

  // Determine diSetupPattern: if no testing-module match was found, check for factory patterns
  if (diSetupPattern === null) {
    for (const [, content] of contentCache) {
      if (/buildCommand\(|buildAgent\(/.test(content)) {
        diSetupPattern = 'factory-function';
        break;
      }
    }
  }

  // errorHandlerExits detection: scan src/ files for both handle( and process.exit(1)
  const errorHandlerExits = (() => {
    const srcDir = path.join(repoDir, 'src');
    if (!fs.existsSync(srcDir)) return false;
    const srcFiles = walkDir(srcDir, () => true, skipDirs).filter(f => /\.(ts|tsx|js|jsx)$/.test(f));
    for (const f of srcFiles) {
      const content = (() => {
        try {
          return fs.readFileSync(f, 'utf-8');
        } catch {
          return '';
        }
      })();
      if (/handle\s*\(/.test(content) && /process\.exit\(1\)/.test(content)) {
        return true;
      }
    }
    return false;
  })();

  // helperPaths — walk full repo for helper file patterns, capped at 10
  const helperFiles = walkDir(repoDir, f => HELPER_PATTERNS.some(p => p.test(f)), skipDirs);
  const helperPaths = helperFiles.slice(0, 10).map(f => path.relative(repoDir, f));

  return {
    fileSuffix,
    mockPrefix,
    mockFactoryPrefix,
    describeStyle,
    helperPaths,
    mockCleanup,
    diSetupPattern,
    errorHandlerExits,
  };
};

/**
 * Detect Node.js test infrastructure from a repository directory.
 */
const detectNode = (repoDir: string): NodeInfra | null => {
  const packageJsonPath = path.join(repoDir, 'package.json');
  const raw = readFileOrNull(packageJsonPath);
  if (!raw) return null;

  let pkg: {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    engines?: { node?: string };
  };
  try {
    pkg = JSON.parse(raw);
  } catch {
    return null;
  }

  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  const frameworks = NODE_FRAMEWORKS.filter(fw => fw in allDeps);

  const allScripts = pkg.scripts ?? {};
  const relevantScripts: Record<string, string> = {};
  for (const [name, value] of Object.entries(allScripts)) {
    if (RELEVANT_SCRIPT_PATTERN.test(name)) {
      relevantScripts[name] = value;
    }
  }

  let nodeVersionMajor: number | null = null;

  if (pkg.engines?.node) {
    nodeVersionMajor = parseNodeMajor(pkg.engines.node);
  }

  if (nodeVersionMajor === null) {
    const nvmrc = readFileOrNull(path.join(repoDir, '.nvmrc'));
    if (nvmrc) {
      nodeVersionMajor = parseNodeMajor(nvmrc);
    }
  }

  if (nodeVersionMajor === null) {
    const nodeVersion = readFileOrNull(path.join(repoDir, '.node-version'));
    if (nodeVersion) {
      nodeVersionMajor = parseNodeMajor(nodeVersion);
    }
  }

  if (nodeVersionMajor === null) {
    const pipelines = readFileOrNull(path.join(repoDir, 'bitbucket-pipelines.yml'));
    if (pipelines) {
      const imageMatch = /image:\s*node:(\d+)/.exec(pipelines);
      if (imageMatch) {
        nodeVersionMajor = parseInt(imageMatch[1], 10);
      }
    }
  }

  return {
    ecosystem: 'node',
    nodeVersionMajor,
    hasNodeTest: nodeVersionMajor !== null && nodeVersionMajor >= 18,
    frameworks,
    scripts: relevantScripts,
    allScriptNames: Object.keys(allScripts),
    testPatterns: detectTestPatterns(repoDir),
  };
};

/**
 * Detect Terraform infrastructure from a repository directory.
 */
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

  const primary: Ecosystem = ecosystems.length > 0 ? ecosystems[0].ecosystem : 'node';

  return { ecosystems, primary };
};

/**
 * Format a prompt section describing the detected test infrastructure.
 *
 * @param ctx - Test infrastructure context from `detectTestInfra()`
 * @returns Multi-line string for injection into AI prompts
 */
const formatTestInfraPromptSection = (ctx: TestInfraContext): string => {
  if (ctx.ecosystems.length === 0) {
    return 'No test infrastructure detected — use only POSIX shell commands.';
  }

  const lines: string[] = [
    'Available test infrastructure in this repository:',
    `Ecosystems detected: ${ctx.ecosystems.map(e => e.ecosystem).join(', ')} (primary: ${ctx.primary})`,
  ];

  for (const eco of ctx.ecosystems) {
    switch (eco.ecosystem) {
      case 'node': {
        const versionLabel = eco.nodeVersionMajor !== null ? `v${eco.nodeVersionMajor}` : 'unknown';
        const nodeTestNote = eco.hasNodeTest ? ' (node:test and node:assert available)' : '';
        lines.push(`- Node.js: ${versionLabel}${nodeTestNote}`);
        if (eco.frameworks.length > 0) {
          lines.push(`- Frameworks: ${eco.frameworks.join(', ')}`);
        }
        if (Object.keys(eco.scripts).length > 0) {
          const scriptEntries = Object.entries(eco.scripts)
            .map(([name, cmd]) => `${name} ("${cmd}")`)
            .join(', ');
          lines.push(`- Scripts: ${scriptEntries}`);
        }
        if (eco.testPatterns) {
          lines.push('');
          lines.push('Test conventions detected in this repository:');
          const suffixLabel
            = eco.testPatterns.fileSuffix === 'mixed' ? '*.spec.ts / *.test.ts' : `*${eco.testPatterns.fileSuffix}.ts`;
          lines.push(`- Test file suffix: ${suffixLabel} (use this suffix for new test files)`);
          if (eco.testPatterns.mockPrefix) {
            const factoryNote = eco.testPatterns.mockFactoryPrefix
              ? `; factories use "${eco.testPatterns.mockFactoryPrefix}" (e.g., ${eco.testPatterns.mockFactoryPrefix}User)`
              : '';
            lines.push(
              `- Mock naming: prefix mocks with "${eco.testPatterns.mockPrefix}" (e.g., ${eco.testPatterns.mockPrefix}User)${factoryNote}`
            );
          }
          lines.push(
            `- Test structure: ${eco.testPatterns.describeStyle === 'nested' ? 'nested' : 'flat'} describe blocks`
          );
          if (eco.testPatterns.helperPaths.length > 0) {
            lines.push(`- Test helpers: ${eco.testPatterns.helperPaths.join(', ')}`);
          }
          if (eco.testPatterns.mockCleanup) {
            lines.push(
              `- Mock isolation: always prescribe \`jest.${eco.testPatterns.mockCleanup}()\` in afterEach() — do NOT leave cleanup steps as conditional; prescribe the exact call`
            );
          }
          if (eco.testPatterns.diSetupPattern === 'testing-module') {
            lines.push(
              '- DI test setup: tests use a testing-module pattern (e.g., Test.createTestingModule). State which DI framework you assume so the implementer can verify.'
            );
          } else if (eco.testPatterns.diSetupPattern === 'factory-function') {
            lines.push(
              '- DI test setup: tests use factory helpers to construct the unit under test. State which factory you assume so the implementer can verify.'
            );
          }
          if (eco.testPatterns.errorHandlerExits) {
            lines.push(
              '- Error handler: ErrorHandler.handle() calls process.exit(1) — tests MUST mock process.exit before invoking code that reaches this handler; rejects.toThrow() alone will not work'
            );
          }
          lines.push('Follow these patterns when prescribing test changes.');
        }
        break;
      }
      case 'terraform': {
        const backendNote = eco.hasBackendConfig ? ' with backend configuration' : '';
        lines.push(`- Terraform files detected${backendNote}`);
        lines.push('- Available commands: terraform validate, terraform plan, terraform fmt -check');
        break;
      }
      case 'python': {
        lines.push(`- Python project detected`);
        if (eco.frameworks.length > 0) {
          lines.push(`- Frameworks: ${eco.frameworks.join(', ')}`);
        }
        break;
      }
      case 'go': {
        lines.push('- Go module detected');
        lines.push('- Available commands: go test ./..., go vet ./...');
        break;
      }
    }
  }

  lines.push('Rules for verification commands:');
  lines.push('- Reference ONLY the scripts and binaries listed above. Do not invent scripts.');
  lines.push('- Each command must verify a specific side effect of THIS plan — not run a generic suite.');

  const nodeEco = ctx.ecosystems.find((e): e is NodeInfra => e.ecosystem === 'node');
  if (nodeEco) {
    lines.push(
      '- Prefer existing scripts with a filter (e.g., "yarn test -- --testPathPattern=pricing") over bare "yarn test".'
    );
    lines.push(
      '- When no matching script exists, prefer inline: node -e "const assert = require(\'node:assert\'); ..."'
    );
    lines.push(
      '- Verification commands MUST be shell-safe by construction. For inline `node -e`, prefer single-quoted JS strings or properly escaped backticks — never rely on unescaped template literals inside double-quoted shell strings.'
    );
  }

  const tfEco = ctx.ecosystems.find((e): e is TerraformInfra => e.ecosystem === 'terraform');
  if (tfEco) {
    lines.push('- Use "terraform validate" for syntax/config checks, "terraform plan" for drift detection.');
    lines.push('- Prefer targeted: "terraform plan -target=module.foo" over bare "terraform plan".');
  }

  lines.push('- Every command must be copy-paste-runnable from the repo root.');

  if (nodeEco) {
    lines.push('');
    lines.push('Allowed verification command forms (exhaustive — do NOT use unlisted commands):');
    lines.push('- node -e "..."');
    lines.push('- sh -c "..." / bash -c "..."');
    for (const [name, cmd] of Object.entries(nodeEco.scripts)) {
      lines.push(`- yarn ${name} -- ... (runs: "${cmd}")`);
    }
  }

  return lines.join('\n');
};

export { detectTestInfra, detectTestPatterns, formatTestInfraPromptSection };
export type { Ecosystem, EcosystemInfra, NodeInfra, TerraformInfra, PythonInfra, GoInfra, TestInfraContext };
