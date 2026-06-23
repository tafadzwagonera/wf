import * as fs from 'fs';
import * as path from 'path';

type Ecosystem = 'node' | 'terraform' | 'python' | 'go';

type NodeFramework = 'jest' | 'vitest' | 'mocha' | 'tap' | 'ava';

interface NodeInfra {
  ecosystem: 'node';
  nodeVersionMajor: number | null;
  hasNodeTest: boolean;
  frameworks: NodeFramework[];
  scripts: Record<string, string>;
  allScriptNames: string[];
}

interface TerraformInfra {
  ecosystem: 'terraform';
  hasTfFiles: boolean;
  hasBackendConfig: boolean;
}

interface PythonInfra {
  ecosystem: 'python';
  frameworks: Array<'pytest' | 'unittest' | 'tox' | 'nox'>;
  hasRequirementsTxt: boolean;
}

interface GoInfra {
  ecosystem: 'go';
  hasGoMod: boolean;
}

type EcosystemInfra = NodeInfra | TerraformInfra | PythonInfra | GoInfra;

interface TestInfraContext {
  ecosystems: EcosystemInfra[];
  primary: Ecosystem;
}

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
  const match = trimmed.match(/(\d+)/);
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
      const imageMatch = pipelines.match(/image:\s*node:(\d+)/);
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
  }

  const tfEco = ctx.ecosystems.find((e): e is TerraformInfra => e.ecosystem === 'terraform');
  if (tfEco) {
    lines.push('- Use "terraform validate" for syntax/config checks, "terraform plan" for drift detection.');
    lines.push('- Prefer targeted: "terraform plan -target=module.foo" over bare "terraform plan".');
  }

  lines.push('- Every command must be copy-paste-runnable from the repo root.');

  return lines.join('\n');
};

export { detectTestInfra, formatTestInfraPromptSection };
export type { Ecosystem, EcosystemInfra, NodeInfra, TerraformInfra, PythonInfra, GoInfra, TestInfraContext };
