import * as fs from 'fs';
import * as path from 'path';
import { of } from 'rxjs';
import { UniversalTicket } from '../../common/dto/universal-ticket.dto';
import { JiraService } from '../../integrations/jira/jira.service';
import { JiraAdapter } from '../../integrations/platforms/jira/jira-adapter';

interface AdfNode {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

export interface JiraUpdateSmokeArgs {
  ticketKey: string;
  descriptionFilePath: string;
  executeLiveUpdate: boolean;
  confirmLiveUpdate: boolean;
}

export interface JiraUpdatePreviewResult {
  ticketKey: string;
  descriptionFilePath?: string;
  payload: { fields: Record<string, unknown> };
  formattingSummary: {
    headingCount: number;
    codeBlockCount: number;
    bulletListCount: number;
    orderedListCount: number;
  };
  serializedPayload: string;
}

/**
 * Parse CLI arguments for the Jira update smoke harness.
 *
 * @param argv - CLI arguments after the manual test name
 * @param currentWorkingDirectory - Directory used to resolve relative paths
 * @param environmentVariables - Environment variables controlling live mode
 * @returns Parsed smoke-test arguments
 */
export const parseJiraUpdateSmokeArgs = (
  argv: string[],
  currentWorkingDirectory = process.cwd(),
  environmentVariables: NodeJS.ProcessEnv = process.env,
): JiraUpdateSmokeArgs => {
  const [ticketKey, ...restArgs] = argv;

  if (!ticketKey || ticketKey.startsWith('-')) {
    throw new Error(
      'Missing ticket key. Usage: nr test:manual -- test-issue-update-jira-adf-smoke <ticket-key> --description-file <path> [--live --confirm-live-update]',
    );
  }

  let descriptionFileArg: string | undefined;
  let confirmLiveUpdate = false;
  let executeLiveUpdate =
    environmentVariables.JIRA_UPDATE_LIVE === '1' ||
    environmentVariables.JIRA_UPDATE_LIVE === 'true';

  for (let index = 0; index < restArgs.length; index += 1) {
    const arg = restArgs[index];

    if (arg === '--description-file') {
      descriptionFileArg = restArgs[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--live') {
      executeLiveUpdate = true;
      continue;
    }

    if (arg === '--confirm-live-update') {
      confirmLiveUpdate = true;
      continue;
    }
  }

  if (!descriptionFileArg) {
    throw new Error('Missing required --description-file <path> argument.');
  }

  if (executeLiveUpdate && !confirmLiveUpdate) {
    throw new Error(
      'Live Jira updates require explicit confirmation via --confirm-live-update.',
    );
  }

  return {
    ticketKey,
    descriptionFilePath: path.resolve(
      currentWorkingDirectory,
      descriptionFileArg,
    ),
    executeLiveUpdate,
    confirmLiveUpdate,
  };
};

/**
 * Load the markdown description file for the Jira update smoke harness.
 *
 * @param descriptionFilePath - Absolute or relative path to the markdown file
 * @returns Trimmed markdown description content
 */
export const loadDescriptionFile = (descriptionFilePath: string): string => {
  if (!fs.existsSync(descriptionFilePath)) {
    throw new Error(
      `Description file not found: ${path.resolve(descriptionFilePath)}`,
    );
  }

  const description = fs.readFileSync(descriptionFilePath, 'utf8').trim();

  if (!description) {
    throw new Error(`Description file is empty: ${descriptionFilePath}`);
  }

  return normalizeDescriptionMarkdown(description);
};

/**
 * Trim ticket-artifact preamble so Jira descriptions start at the body
 * sections instead of repeating title and metadata.
 *
 * @param markdown - Raw markdown loaded from the generated description file
 * @returns Markdown starting at the first summary section when present
 */
export const normalizeDescriptionMarkdown = (markdown: string): string => {
  const summaryHeadingMatch = markdown.match(/^### Summary\s*$/m);

  if (!summaryHeadingMatch?.index) {
    return markdown.trim();
  }

  return markdown.slice(summaryHeadingMatch.index).trim();
};

const collectAdfNodes = (node: unknown): AdfNode[] => {
  if (!node || typeof node !== 'object') {
    return [];
  }

  if (Array.isArray(node)) {
    return node.flatMap(collectAdfNodes);
  }

  const objectNode = node as AdfNode;
  return [
    objectNode,
    ...Object.values(objectNode).flatMap((value) => collectAdfNodes(value)),
  ];
};

const summarizeAdf = (
  adfDocument: unknown,
): JiraUpdatePreviewResult['formattingSummary'] => {
  const adfNodes = collectAdfNodes(adfDocument);

  return {
    headingCount: adfNodes.filter((node) => node.type === 'heading').length,
    codeBlockCount: adfNodes.filter((node) => node.type === 'codeBlock').length,
    bulletListCount: adfNodes.filter((node) => node.type === 'bulletList')
      .length,
    orderedListCount: adfNodes.filter((node) => node.type === 'orderedList')
      .length,
  };
};

/**
 * Execute the Jira update adapter/service path with a stubbed PUT request so
 * the outgoing payload can be inspected without mutating Jira.
 *
 * @param options - Preview execution dependencies and ticket content
 * @returns Captured Jira REST payload and formatting diagnostics
 */
export const captureJiraDescriptionUpdatePreview = async (options: {
  ticketKey: string;
  description: string;
  adapter: JiraAdapter;
  jiraService: JiraService;
}): Promise<JiraUpdatePreviewResult> => {
  const { adapter, jiraService, description, ticketKey } = options;
  const httpService = (jiraService as any).httpService as {
    put: (...args: unknown[]) => unknown;
  };
  const logger = (jiraService as any).logger as {
    success: (...args: unknown[]) => void;
  };
  const originalPut = httpService.put;
  const originalSuccess = logger.success;
  const putCalls: unknown[][] = [];

  httpService.put = (...args: unknown[]) => {
    putCalls.push(args);
    return of({ data: {} });
  };
  logger.success = () => undefined;

  try {
    await adapter.updateTicket(
      ticketKey,
      new UniversalTicket({
        description,
      }),
    );
  } finally {
    httpService.put = originalPut;
    logger.success = originalSuccess;
  }

  if (putCalls.length !== 1) {
    throw new Error(
      `Expected one Jira PUT preview call, received ${putCalls.length}.`,
    );
  }

  const [, payload] = putCalls[0] as [
    string,
    { fields: Record<string, unknown> },
  ];
  const descriptionAdf = payload.fields.description;

  return {
    ticketKey,
    payload,
    formattingSummary: summarizeAdf(descriptionAdf),
    serializedPayload: JSON.stringify(payload, null, 2),
  };
};

/**
 * Run the Jira update smoke test in preview or live mode.
 *
 * @param options - Resolved CLI arguments and adapter/service dependencies
 * @returns Preview diagnostics for the outgoing Jira payload
 */
export const runJiraUpdateSmokeTest = async (options: {
  ticketKey: string;
  descriptionFilePath: string;
  executeLiveUpdate: boolean;
  adapter: JiraAdapter;
  jiraService: JiraService;
}): Promise<JiraUpdatePreviewResult> => {
  const description = loadDescriptionFile(options.descriptionFilePath);
  const previewResult = await captureJiraDescriptionUpdatePreview({
    ticketKey: options.ticketKey,
    description,
    adapter: options.adapter,
    jiraService: options.jiraService,
  });

  if (options.executeLiveUpdate) {
    await options.adapter.updateTicket(
      options.ticketKey,
      new UniversalTicket({
        description,
      }),
    );
  }

  return {
    ...previewResult,
    descriptionFilePath: options.descriptionFilePath,
  };
};
