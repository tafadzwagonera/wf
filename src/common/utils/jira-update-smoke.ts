import * as fs from 'fs';
import * as path from 'path';
import { of } from 'rxjs';
import { UniversalTicket } from '../dto/universal-ticket.dto';
import { stripRedundantSections } from '../utils/markdown-text';
import { JiraService } from '../../integrations/jira/jira.service';
import { JiraAdapter } from '../../integrations/issue-trackers/jira/jira-adapter';

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

interface ParsedRestArgs {
  descriptionFileArg?: string;
  confirmLiveUpdate: boolean;
  executeLiveUpdate: boolean;
}

/**
 * Reject a missing or flag-shaped ticket key argument.
 *
 * @param ticketKey - First positional CLI argument
 * @returns The validated ticket key
 */
const requireTicketKey = (ticketKey: string | undefined): string => {
  if (!ticketKey || ticketKey.startsWith('-')) {
    throw new Error(
      'Missing ticket key. Usage: yarn test:manual issue-update-jira-adf.smoke <ticket-key> --description-file <path> [--live --confirm-live-update]'
    );
  }
  return ticketKey;
};

/**
 * Determine whether live-update mode defaults to on via environment variables.
 *
 * @param environmentVariables - Environment variables controlling live mode
 * @returns Whether JIRA_UPDATE_LIVE requests live-update mode
 */
const isLiveUpdateEnabled = (environmentVariables: NodeJS.ProcessEnv): boolean =>
  environmentVariables.JIRA_UPDATE_LIVE === '1' || environmentVariables.JIRA_UPDATE_LIVE === 'true';

/**
 * Apply a single CLI flag to the in-progress parsed rest-args, returning the
 * index to resume scanning from (advanced by one for flags with a value).
 *
 * @param restArgs - CLI arguments after the ticket key
 * @param index - Index of the flag currently being applied
 * @param parsed - Rest-args accumulator mutated in place
 * @returns The index to resume the scan from
 */
const applyRestArgFlag = (restArgs: string[], index: number, parsed: ParsedRestArgs): number => {
  const arg = restArgs[index];

  if (arg === '--description-file') {
    parsed.descriptionFileArg = restArgs[index + 1];
    return index + 1;
  }
  if (arg === '--live') {
    parsed.executeLiveUpdate = true;
  }
  if (arg === '--confirm-live-update') {
    parsed.confirmLiveUpdate = true;
  }
  return index;
};

/**
 * Parse the flags following the ticket key for the Jira update smoke harness.
 *
 * @param restArgs - CLI arguments after the ticket key
 * @param initialExecuteLiveUpdate - Live-update default sourced from env vars
 * @returns Parsed flag values
 */
const parseRestArgs = (restArgs: string[], initialExecuteLiveUpdate: boolean): ParsedRestArgs => {
  const parsed: ParsedRestArgs = { confirmLiveUpdate: false, executeLiveUpdate: initialExecuteLiveUpdate };

  for (let index = 0; index < restArgs.length; index += 1) {
    index = applyRestArgFlag(restArgs, index, parsed);
  }

  return parsed;
};

/**
 * Reject rest-args missing a description file, or requesting a live update
 * without explicit confirmation.
 *
 * @param parsed - Parsed rest-args to validate
 */
const validateParsedRestArgs = (parsed: ParsedRestArgs): void => {
  if (!parsed.descriptionFileArg) {
    throw new Error('Missing required --description-file <path> argument.');
  }
  if (parsed.executeLiveUpdate && !parsed.confirmLiveUpdate) {
    throw new Error('Live Jira updates require explicit confirmation via --confirm-live-update.');
  }
};

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
  environmentVariables: NodeJS.ProcessEnv = process.env
): JiraUpdateSmokeArgs => {
  const ticketKey = requireTicketKey(argv[0]);
  const parsed = parseRestArgs(argv.slice(1), isLiveUpdateEnabled(environmentVariables));
  validateParsedRestArgs(parsed);

  return {
    ticketKey,
    descriptionFilePath: path.resolve(currentWorkingDirectory, parsed.descriptionFileArg as string),
    executeLiveUpdate: parsed.executeLiveUpdate,
    confirmLiveUpdate: parsed.confirmLiveUpdate,
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
    throw new Error(`Description file not found: ${path.resolve(descriptionFilePath)}`);
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
  const summaryHeadingMatch = /^### Summary\s*$/m.exec(markdown);
  const trimmed = summaryHeadingMatch?.index ? markdown.slice(summaryHeadingMatch.index).trim() : markdown.trim();

  return stripRedundantSections(trimmed);
};

const collectAdfNodes = (node: unknown): AdfNode[] => {
  if (!node || typeof node !== 'object') {
    return [];
  }

  if (Array.isArray(node)) {
    return node.flatMap(collectAdfNodes);
  }

  const objectNode = node as AdfNode;
  return [objectNode, ...Object.values(objectNode).flatMap(value => collectAdfNodes(value))];
};

const summarizeAdf = (adfDocument: unknown): JiraUpdatePreviewResult['formattingSummary'] => {
  const adfNodes = collectAdfNodes(adfDocument);

  return {
    headingCount: adfNodes.filter(node => node.type === 'heading').length,
    codeBlockCount: adfNodes.filter(node => node.type === 'codeBlock').length,
    bulletListCount: adfNodes.filter(node => node.type === 'bulletList').length,
    orderedListCount: adfNodes.filter(node => node.type === 'orderedList').length,
  };
};

interface JiraPutStub {
  originalPut: (...args: unknown[]) => unknown;
  originalSuccess: (...args: unknown[]) => void;
  putCalls: unknown[][];
}

/**
 * Replace a Jira service's HTTP PUT and success logger with capturing stubs.
 *
 * @param jiraService - Jira service whose HTTP PUT is temporarily stubbed
 * @returns The originals to restore later, plus the calls captured so far
 */
const installJiraPutStub = (jiraService: JiraService): JiraPutStub => {
  const httpService = (jiraService as any).httpService as { put: (...args: unknown[]) => unknown };
  const logger = (jiraService as any).logger as { success: (...args: unknown[]) => void };
  const putCalls: unknown[][] = [];
  const originalPut = httpService.put;
  const originalSuccess = logger.success;

  httpService.put = (...args: unknown[]) => {
    putCalls.push(args);
    return of({ data: {} });
  };
  logger.success = () => undefined;

  return { originalPut, originalSuccess, putCalls };
};

/**
 * Restore a Jira service's HTTP PUT and success logger to their originals.
 *
 * @param jiraService - Jira service previously stubbed by installJiraPutStub
 * @param stub - Originals captured by installJiraPutStub
 */
const restoreJiraPutStub = (jiraService: JiraService, stub: JiraPutStub): void => {
  (jiraService as any).httpService.put = stub.originalPut;
  (jiraService as any).logger.success = stub.originalSuccess;
};

/**
 * Stub a Jira service's PUT call for the duration of `execute`, capturing
 * every call's arguments and restoring the originals afterward.
 *
 * @param jiraService - Jira service whose HTTP PUT is temporarily stubbed
 * @param execute - Action to run while the PUT call is stubbed
 * @returns Arguments captured from each stubbed PUT call
 */
const withStubbedJiraPut = async (jiraService: JiraService, execute: () => Promise<void>): Promise<unknown[][]> => {
  const stub = installJiraPutStub(jiraService);

  try {
    await execute();
  } finally {
    restoreJiraPutStub(jiraService, stub);
  }

  return stub.putCalls;
};

/**
 * Assert exactly one Jira PUT call happened and return its payload.
 *
 * @param putCalls - Arguments captured from stubbed PUT calls
 * @returns The single captured PUT call's request payload
 */
const extractSinglePutPayload = (putCalls: unknown[][]): { fields: Record<string, unknown> } => {
  if (putCalls.length !== 1) {
    throw new Error(`Expected one Jira PUT preview call, received ${putCalls.length}.`);
  }
  const [, payload] = putCalls[0] as [string, { fields: Record<string, unknown> }];
  return payload;
};

interface CaptureJiraDescriptionUpdatePreviewOptions {
  ticketKey: string;
  description: string;
  adapter: JiraAdapter;
  jiraService: JiraService;
}

/**
 * Execute the Jira update adapter/service path with a stubbed PUT request so
 * the outgoing payload can be inspected without mutating Jira.
 *
 * @param options - Preview execution dependencies and ticket content
 * @returns Captured Jira REST payload and formatting diagnostics
 */
export const captureJiraDescriptionUpdatePreview = async (
  options: CaptureJiraDescriptionUpdatePreviewOptions
): Promise<JiraUpdatePreviewResult> => {
  const { adapter, jiraService, description, ticketKey } = options;
  const putCalls = await withStubbedJiraPut(jiraService, () =>
    adapter.updateTicket(ticketKey, new UniversalTicket({ description }))
  );
  const payload = extractSinglePutPayload(putCalls);

  return {
    ticketKey,
    payload,
    formattingSummary: summarizeAdf(payload.fields.description),
    serializedPayload: JSON.stringify(payload, null, 2),
  };
};

interface MaybeExecuteLiveUpdateOptions {
  executeLiveUpdate: boolean;
  ticketKey: string;
  description: string;
  adapter: JiraAdapter;
}

/**
 * Send the live Jira update when `executeLiveUpdate` is set, otherwise no-op.
 *
 * @param options - Live-update flag and the adapter call's arguments
 * @returns Resolves once the live update (if any) has been sent
 */
const maybeExecuteLiveUpdate = async (options: MaybeExecuteLiveUpdateOptions): Promise<void> => {
  if (!options.executeLiveUpdate) {
    return;
  }
  await options.adapter.updateTicket(options.ticketKey, new UniversalTicket({ description: options.description }));
};

interface RunJiraUpdateSmokeTestOptions {
  ticketKey: string;
  descriptionFilePath: string;
  executeLiveUpdate: boolean;
  adapter: JiraAdapter;
  jiraService: JiraService;
}

/**
 * Run the Jira update smoke test in preview or live mode.
 *
 * @param options - Resolved CLI arguments and adapter/service dependencies
 * @returns Preview diagnostics for the outgoing Jira payload
 */
export const runJiraUpdateSmokeTest = async (
  options: RunJiraUpdateSmokeTestOptions
): Promise<JiraUpdatePreviewResult> => {
  const description = loadDescriptionFile(options.descriptionFilePath);
  const { ticketKey, adapter, jiraService, executeLiveUpdate } = options;
  const previewResult = await captureJiraDescriptionUpdatePreview({ ticketKey, description, adapter, jiraService });

  await maybeExecuteLiveUpdate({ executeLiveUpdate, ticketKey, description, adapter });

  return { ...previewResult, descriptionFilePath: options.descriptionFilePath };
};
