/**
 * ADF Request Format Validator
 *
 * Run: echo '{"fields":{"description":{...}}}' | nr test:manual verify-request-format.smoke.ts
 *
 * Reads a serialized Jira REST payload (or bare ADF doc) from stdin,
 * walks the node tree, and outputs structured JSON diagnostics.
 * Exits 0 when valid, 1 when issues are found.
 */

interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
  [key: string]: unknown;
}

interface ValidationIssue {
  error: string;
  suggestion: string;
}

interface ValidationResult {
  passed: boolean;
  issues: ValidationIssue[];
}

const RULES: Array<{
  pattern: RegExp;
  error: (path: string) => string;
  suggestion: string;
}> = [
  {
    pattern: /\{code(?::[^}]*)?\}/,
    error: p => `raw \`{code}\` marker in text node at \`${p}\``,
    suggestion: 'Replace `{code:lang}...{code}` with markdown code fences: ```lang\\n...\\n```',
  },
  {
    pattern: /\{noformat\}/,
    error: p => `raw \`{noformat}\` marker in text node at \`${p}\``,
    suggestion: 'Replace `{noformat}...{noformat}` with markdown code fences: ```\\n...\\n```',
  },
  {
    pattern: /\{\{[^}]+\}\}/,
    error: p => `raw \`{{...}}\` marker in text node at \`${p}\``,
    suggestion: 'Replace `{{text}}` with markdown inline code: `text`',
  },
  {
    pattern: /^\*\s+/m,
    error: p => `raw \`* \` bullet marker in text node at \`${p}\``,
    suggestion: 'Replace wiki `* item` with markdown `- item` at line start',
  },
];

const checkTextNode = (text: string, path: string, issues: ValidationIssue[]): void => {
  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      issues.push({
        error: rule.error(path),
        suggestion: rule.suggestion,
      });
    }
  }
};

const walkNodes = (node: AdfNode, path: string, issues: ValidationIssue[]): void => {
  if (node.type === 'text' && typeof node.text === 'string') {
    checkTextNode(node.text, path, issues);
  }

  if (Array.isArray(node.content)) {
    for (const [i, child] of node.content.entries()) {
      walkNodes(child, `${path}.content[${i}]`, issues);
    }
  }
};

const extractDoc = (input: unknown): AdfNode => {
  const asPayload = input as { fields?: { description?: AdfNode } };
  return asPayload?.fields?.description ? asPayload.fields.description : (input as AdfNode);
};

const validateDocType = (doc: AdfNode, issues: ValidationIssue[]): boolean => {
  if (doc?.type !== 'doc') {
    issues.push({
      error: 'ADF root node is not `type: "doc"`',
      suggestion: 'Description must be a valid ADF document with `type: "doc"`',
    });
    return false;
  }
  return true;
};

const validateDocHasContent = (doc: AdfNode, issues: ValidationIssue[]): boolean => {
  if (!Array.isArray(doc.content) || doc.content.length === 0) {
    issues.push({
      error: 'ADF document has no block nodes in `content`',
      suggestion: 'Description must contain at least one block node (paragraph, heading, etc.)',
    });
    return false;
  }
  return true;
};

const validate = (input: unknown): ValidationResult => {
  const issues: ValidationIssue[] = [];
  const doc = extractDoc(input);

  if (!validateDocType(doc, issues) || !validateDocHasContent(doc, issues)) {
    return { passed: false, issues };
  }

  walkNodes(doc, 'doc', issues);
  return { passed: issues.length === 0, issues };
};

function outputAndExit(result: ValidationResult): void {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.passed ? 0 : 1);
}

function handleNoInput(): void {
  outputAndExit({
    passed: false,
    issues: [{
      error: 'No input received on stdin',
      suggestion: 'Pipe a JSON payload to stdin: echo \'{"fields":...}\' | nr test:manual verify-request-format.smoke.ts',
    }],
  });
}

function handleInvalidJson(): void {
  outputAndExit({
    passed: false,
    issues: [{ error: 'Invalid JSON on stdin', suggestion: 'Input must be valid JSON' }],
  });
}

function processInput(raw: string): void {
  if (!raw) {
    handleNoInput();
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    handleInvalidJson();
    return;
  }
  outputAndExit(validate(parsed));
}

function main(): void {
  const chunks: Buffer[] = [];
  process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
  process.stdin.on('end', () => {
    processInput(Buffer.concat(chunks).toString('utf-8').trim());
  });
}

main();
