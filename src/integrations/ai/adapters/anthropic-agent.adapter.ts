// src/integrations/ai/adapters/anthropic-agent.adapter.ts
import { ConfigService } from '@nestjs/config';
import {
  type CanUseTool,
  type SDKResultMessage,
  type Settings,
  type SettingSource,
} from '@anthropic-ai/claude-agent-sdk';
import chalk from 'chalk';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type {
  TicketArtifact,
  PlanArtifact,
  ImplementerOptions,
  IImplementerBackend,
  VerificationScript,
} from '../../../agents/interfaces';
import { loadAnthropicAgentSdk } from './load-anthropic-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const CLAUDE_CODE_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Glob',
  'Grep',
  'TodoWrite',
  'Task',
  'Agent',
] as const;

const normalizeCommand = (command: unknown): string =>
  typeof command === 'string' ? command.trim() : '';

const buildAllowedCommands = (
  verificationScripts: VerificationScript[],
): Set<string> =>
  new Set(
    verificationScripts
      .map((script) => script.command.trim())
      .filter((command) => command.length > 0),
  );

const buildCanUseTool = (allowedCommands: Set<string>): CanUseTool => {
  return async (toolName, input) => {
    if (toolName !== 'Bash') {
      return { behavior: 'allow' };
    }

    const command = normalizeCommand(input['command']);
    if (!command) {
      return {
        behavior: 'deny',
        message: 'Bash command missing a command string.',
        interrupt: true,
      };
    }

    if (!allowedCommands.has(command)) {
      return {
        behavior: 'deny',
        message: `Bash command "${command}" is not in the verification whitelist. Allowed commands: ${[...allowedCommands].join(', ') || '(none configured)'}.`,
        interrupt: true,
      };
    }

    return { behavior: 'allow' };
  };
};

const resolveRepoPath = (repoDir: string, rawPath: string): string =>
  path.isAbsolute(rawPath) ? rawPath : path.resolve(repoDir, rawPath);

const readOptionalFile = async (filePath: string): Promise<string | null> => {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
};

const warnMissingClaudeFile = (filePath: string): void => {
  console.log(chalk.yellow(`⚠️ Missing CLAUDE.md file at ${filePath}`));
};

/**
 * Format a streamed progress event for console output.
 *
 * @param message - The SDK progress message to format
 * @returns A human-readable log line, or null when the message is not progress
 */
export const formatProgressMessage = (message: SDKMessage): string | null => {
  if (message.type === 'system' && message.subtype === 'task_progress') {
    const summary = message.summary?.trim() || message.description.trim();
    const lastToolLabel = message.last_tool_name
      ? ` · last tool: ${message.last_tool_name}`
      : '';
    return `  [claude-agent-sdk] Task progress: ${summary}${lastToolLabel}`;
  }

  if (message.type === 'tool_progress') {
    const elapsedSeconds = message.elapsed_time_seconds.toFixed(1);
    const taskLabel = message.task_id ? ` · task: ${message.task_id}` : '';
    return `  [claude-agent-sdk] Tool progress: ${message.tool_name} (${elapsedSeconds}s)${taskLabel}`;
  }

  return null;
};

/**
 * Print a streamed progress event when the SDK emits one.
 *
 * @param message - The SDK message to inspect
 * @returns True when the message was handled as progress
 */
const logProgressMessage = (message: SDKMessage): boolean => {
  const formattedMessage = formatProgressMessage(message);
  if (!formattedMessage) {
    return false;
  }

  console.log(chalk.cyan(formattedMessage));
  return true;
};

const loadClaudeContext = async (repoDir: string): Promise<string> => {
  const globalClaudePath = path.join(os.homedir(), '.claude', 'CLAUDE.md');
  const repoClaudePath = path.join(repoDir, 'CLAUDE.md');
  const [rootClaude, dotClaude] = await Promise.all([
    readOptionalFile(globalClaudePath),
    readOptionalFile(repoClaudePath),
  ]);

  if (rootClaude === null) {
    warnMissingClaudeFile(globalClaudePath);
  }

  if (dotClaude === null) {
    warnMissingClaudeFile(repoClaudePath);
  }

  const sections = [
    rootClaude && `## ~/.claude/CLAUDE.md\n${rootClaude.trimEnd()}`,
    dotClaude && `## CLAUDE.md\n${dotClaude.trimEnd()}`,
  ].filter(Boolean);

  return sections.join('\n\n');
};

const formatRepoFileList = (repoFiles: string[], repoName: string): string => {
  if (repoFiles.length === 0) {
    return '  (none listed)';
  }

  return repoFiles
    .map((filePath) => {
      const relativePath =
        repoName && filePath.startsWith(`${repoName}/`)
          ? filePath.slice(repoName.length + 1)
          : filePath;
      return `  - ${relativePath}`;
    })
    .join('\n');
};

const buildSystemPrompt = ({
  repoDir,
  repoName,
  repoFiles,
  trackedFilePaths,
  verificationScripts,
  sceneContext,
}: {
  repoDir: string;
  repoName: string;
  repoFiles: string[];
  trackedFilePaths: string[];
  verificationScripts: VerificationScript[];
  sceneContext: string;
}): string => {
  const fileList = formatRepoFileList(repoFiles, repoName);
  const trackedFileList = formatRepoFileList(trackedFilePaths, repoName);
  const verificationList =
    verificationScripts.length > 0
      ? verificationScripts.map((script) => `  - ${script.command}`).join('\n')
      : '  (none configured)';

  return `You are an expert software engineer implementing code changes inside a repository.

Repository directory: ${repoDir}
Files to implement:
${fileList}

Tracked files:
${trackedFileList}

Verification commands (run these to check your work):
${verificationList}

Rules:
- Use Read to inspect existing file contents before modifying them
- Use Write or Edit to write complete updated file contents
- Use Bash only for verification commands that appear in the verification whitelist
- Writes are allowed only within the primary repository (${repoDir})
- Reads are allowed from ${repoDir} and any configured read-only sibling repositories
- Treat streamed progress updates as heuristics: continue when they point to forward motion, revisit when the pass looks stuck, and stop only when the agent returns a final result.
- When all verification commands pass (exit 0) — or when you determine no file changes are required — stop and output ONLY the following summary, filled in with actual results. Do not add preamble or planning text.

### What I changed
<Bullet list of actual edits made. If nothing was changed, write: "No file content changes were required.">

### Verification run
<Bullet list of commands run with ✅ (pass) or ❌ (fail). Omit if no commands ran.>

### Files
- **Updated:** <comma-separated list or "none">
- **New:** <comma-separated list or "none">
- **Deleted:** <comma-separated list or "none">

### Assumptions / risk note
<Any assumptions made or risks identified. Write "None." if there are none.>

Task context:
${sceneContext}`;
};

/**
 * Claude Agent SDK-backed implementer backend.
 * The SDK drives the edit loop directly with built-in Read / Write / Edit / Bash
 * tools while this adapter constrains the working directory, filesystem access,
 * and Bash verification commands.
 */
export class AnthropicAgentAdapter implements IImplementerBackend {
  constructor(private configService: ConfigService) {}

  async generateAndVerify(params: {
    ticket: TicketArtifact;
    planArtifact: PlanArtifact;
    options: ImplementerOptions;
    verificationScripts: VerificationScript[];
    sceneContext: string;
    repoFiles: string[];
    repoName: string;
    trackedFilePaths: string[];
  }): Promise<void> {
    const { options, verificationScripts, sceneContext, repoFiles, repoName } =
      params;

    const repoDir = options.repoDir ?? process.cwd();
    const additionalRepoDirs = options.additionalRepoDirs ?? [];
    const allowedCommands = buildAllowedCommands(verificationScripts);
    const apiKey = this.configService.get<string>('ai.anthropicApiKey');
    const claudeContext = await loadClaudeContext(repoDir);

    if (!apiKey) {
      throw new Error(
        'Anthropic Agent SDK backend requires `ai.anthropicApiKey` to be configured.',
      );
    }

    const model =
      this.configService.get<string>('stages.implement.model') ||
      this.configService.get<string>('ai.model') ||
      'claude-sonnet-4-6';

    const sdkOptions = {
      cwd: repoDir,
      model,
      tools: [...CLAUDE_CODE_TOOLS],
      allowedTools: [...CLAUDE_CODE_TOOLS],
      permissionMode: 'acceptEdits' as const,
      // Emit periodic task summaries so the CLI can mirror long-running agent
      // progress instead of waiting for the final result only.
      agentProgressSummaries: true,
      settingSources: ['project'] as SettingSource[],
      settings: {
        claudeMdExcludes: [
          path.join(repoDir, 'CLAUDE.md'),
          path.join(repoDir, '.claude', 'CLAUDE.md'),
        ],
      } satisfies Settings,
      systemPrompt: {
        type: 'preset' as const,
        preset: 'claude_code' as const,
        append: [
          claudeContext ? `\n\nRepo AI context:\n${claudeContext}` : '',
          `\n\n${buildSystemPrompt({
            repoDir,
            repoName,
            repoFiles,
            trackedFilePaths: params.trackedFilePaths,
            verificationScripts,
            sceneContext,
          })}`,
        ].join(''),
      },
      canUseTool: buildCanUseTool(allowedCommands),
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: apiKey,
      },
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        autoAllowBashIfSandboxed: true,
        filesystem: {
          allowRead: [
            resolveRepoPath(repoDir, '.'),
            ...additionalRepoDirs.map((dir) => resolveRepoPath(repoDir, dir)),
          ],
          allowWrite: [resolveRepoPath(repoDir, '.')],
        },
      },
    };

    const { query } = await loadAnthropicAgentSdk();
    const session = query({
      prompt:
        'Implement the changes described in your instructions now. Use Read to inspect existing files, then Write or Edit to apply changes, then Bash for each verification step. Do not output any text or plan before making your first tool call.',
      options: sdkOptions,
    });

    let finalResult: SDKResultMessage | undefined;

    console.log(
      chalk.bold.cyan(
        `\n  [claude-agent-sdk] Running agent loop in ${repoDir}...`,
      ),
    );

    try {
      for await (const message of session) {
        if (logProgressMessage(message)) {
          continue;
        }

        if (message.type !== 'result') {
          continue;
        }

        finalResult = message;
        break;
      }
    } finally {
      session.close();
    }

    if (!finalResult) {
      throw new Error('Claude Agent SDK finished without returning a result.');
    }

    if (finalResult.subtype !== 'success' || finalResult.is_error) {
      const errorSummary =
        'errors' in finalResult && finalResult.errors.length > 0
          ? finalResult.errors.join('; ')
          : 'unknown error';
      throw new Error(
        `Claude Agent SDK failed (${finalResult.subtype}): ${errorSummary}`,
      );
    }

    console.log(
      chalk.green(
        `  [claude-agent-sdk] Agent completed in ${finalResult.num_turns} turn(s).`,
      ),
    );

    const summary = finalResult.result.trim();
    if (summary) {
      console.log(chalk.bold('\n  Summary:'));
      summary.split('\n').forEach((line) => {
        if (line.trim()) {
          console.log(chalk.cyan(`    ${line}`));
        }
      });
    } else {
      console.log(chalk.gray('\n  File summary: no file changes were made.'));
    }
  }
}
