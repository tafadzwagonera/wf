import { inspect } from 'util';
import { convertCapturedToEntries, convertChangesToEntries } from '../../shared/schemas/review.schema';
import type {
  ReviewTraceCallStackNode,
  ReviewTraceCapturedEntry,
  ReviewTraceChangeEntry,
  ReviewTraceValueChange,
  ReviewTraceStateNode,
  ReviewTraceStateTransition,
} from '../../shared/types/review.types';

export type {
  ReviewTraceCallStackNode,
  ReviewTraceValueChange,
  ReviewTraceStateNode,
  ReviewTraceStateTransition,
} from '../../shared/types/review.types';

/**
 * Format an object value using Node's inspect utility.
 * @param value The value to inspect
 * @returns Multi-line string representation
 */
const inspectValue = (value: unknown): string =>
  inspect(value, {
    depth: 6,
    colors: false,
    compact: false,
    breakLength: 80,
    sorted: true,
  });

const formatValue = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }

  if (value == null) {
    return String(value);
  }

  return inspectValue(value);
};

const indentMultilineValue = (value: string, indent: string): string =>
  value
    .split('\n')
    .map((line, index) => (index === 0 ? line : `${indent}${line}`))
    .join('\n');

const normalizeCallStackNode = (node: ReviewTraceCallStackNode | string): ReviewTraceCallStackNode => {
  if (typeof node === 'string') {
    return { frame: node };
  }

  return {
    frame: node.frame,
    children: node.children?.map(normalizeCallStackNode),
  };
};

/**
 * Build the legacy changes array from a node with `state`/`next` fields.
 * @param typedNode Partial node to extract legacy fields from
 * @returns Array of change entries or undefined when empty
 */
const buildLegacyChanges = (
  typedNode: Partial<ReviewTraceStateNode> & Record<string, unknown>
): ReviewTraceChangeEntry[] | undefined => {
  const legacyChanges: ReviewTraceChangeEntry[] = [];

  if ('state' in typedNode && typedNode.state !== undefined) {
    legacyChanges.push({ name: 'state', after: typedNode.state });
  }

  if ('next' in typedNode && typedNode.next !== undefined) {
    legacyChanges.push({ name: 'next', after: typedNode.next });
  }

  return legacyChanges.length > 0 ? legacyChanges : undefined;
};

/**
 * Map a legacy (non-frame) state node shape into a normalized ReviewTraceStateNode.
 * @param typedNode Partial node that lacks a string `frame` property
 * @returns Normalized state node using legacy `state`/`next` fields
 */
const mapLegacyStateNode = (
  typedNode: Partial<ReviewTraceStateNode> & Record<string, unknown>
): ReviewTraceStateNode => ({
  frame: typeof typedNode.state === 'string' ? typedNode.state : 'state',
  changes: buildLegacyChanges(typedNode),
  children: Array.isArray(typedNode.children)
    ? typedNode.children.map(child => normalizeStateNode(child as ReviewTraceStateNode | Record<string, unknown>))
    : undefined,
});

const toEntries = <T>(converted: unknown): T[] | undefined => (Array.isArray(converted) ? converted : undefined);

const normalizeStateNode = (node: ReviewTraceStateNode | Record<string, unknown>): ReviewTraceStateNode => {
  const typedNode = node as Partial<ReviewTraceStateNode> & Record<string, unknown>;

  if (typeof typedNode.frame !== 'string') {
    return mapLegacyStateNode(typedNode);
  }

  return {
    frame: typedNode.frame,
    captured: toEntries<ReviewTraceCapturedEntry>(convertCapturedToEntries(typedNode.captured)),
    changes: toEntries<ReviewTraceChangeEntry>(convertChangesToEntries(typedNode.changes)),
    children: Array.isArray(typedNode.children)
      ? typedNode.children.map(child => normalizeStateNode(child as ReviewTraceStateNode | Record<string, unknown>))
      : undefined,
  };
};

/**
 * Produce the decorated lines for a single call-stack tree node.
 * @param node The normalized call-stack node to render
 * @param prefix Current indentation prefix
 * @param isLast Whether this node is the last sibling
 * @param renderNode Function that produces display lines for a node
 * @returns Lines for this node including its children subtree
 */
const formatTreeLine = (node: ReviewTraceCallStackNode, prefix: string, isLast: boolean,
  renderNode: (n: ReviewTraceCallStackNode) => string[]): string[] => {
  const branch = isLast ? '└─' : '├─';
  const nextPrefix = `${prefix}${isLast ? '   ' : '│  '}`;
  const rendered = renderNode(node);
  const lines = [`${prefix}${branch} ${rendered[0]}`];
  if (node.children?.length) {
    lines.push(...renderTree(node.children, renderNode, nextPrefix));
  }
  if (rendered.length > 1) {
    lines.push(...rendered.slice(1).map(line => `${nextPrefix}${line}`));
  }
  return lines;
};

const renderTree = (
  nodes: Array<ReviewTraceCallStackNode | string>,
  renderNode: (node: ReviewTraceCallStackNode) => string[],
  prefix = ''
): string[] => {
  const normalizedNodes = nodes.map(normalizeCallStackNode);

  return normalizedNodes.flatMap((node, index) =>
    formatTreeLine(node, prefix, index === normalizedNodes.length - 1, renderNode)
  );
};

/**
 * Render before/after sub-lines for a structured value change.
 * @param key The change key name
 * @param value The ReviewTraceValueChange with before/after fields
 * @param valuePrefix Indentation prefix for value lines
 * @param branch The branch character (`└─` or `├─`) for the key line
 * @param subIndent The sub-indentation string for before/after lines
 * @returns Lines for the key header and before/after values
 */
const renderBeforeAfterEntry = (key: string, value: ReviewTraceValueChange, valuePrefix: string,
  branch: string, subIndent: string): string[] => {
  const sides = [
    { label: 'before', value: value.before },
    { label: 'after', value: value.after },
  ].filter(side => side.value !== undefined);

  return [
    `${valuePrefix}${branch} ${key} =`,
    ...sides.map((side, index) => {
      const sideBranch = index === sides.length - 1 ? '└─' : '├─';
      return `${valuePrefix}${subIndent}${sideBranch} ${side.label} = ${indentMultilineValue(formatValue(side.value), `${valuePrefix}${subIndent}   `)}`;
    }),
  ];
};

/**
 * Render the display lines for a single change entry within a state node changes block.
 * @param entry The change entry with name, before, and after fields
 * @param valuePrefix Indentation prefix for value lines
 * @param isLastEntry Whether this is the last entry in the changes array
 * @returns Lines representing this change entry
 */
const renderChangeEntry = (entry: ReviewTraceChangeEntry, valuePrefix: string,
  isLastEntry: boolean): string[] => {
  const branch = isLastEntry ? '└─' : '├─';
  const subIndent = isLastEntry ? '   ' : '│  ';
  return renderBeforeAfterEntry(entry.name, entry, valuePrefix, branch, subIndent);
};

/**
 * Render lines for the changes section of a state node.
 * @param changes Array of change entries with name, before, and after fields
 * @param childPrefix Indentation prefix for the section header
 * @param hasChildren Whether the node has child state nodes
 * @returns Lines for the changes section header and entries
 */
const renderChangesSection = (
  changes: ReviewTraceChangeEntry[],
  childPrefix: string,
  hasChildren: boolean
): string[] => {
  const sectionBranch = hasChildren ? '├─' : '└─';
  const valuePrefix = `${childPrefix}${hasChildren ? '│  ' : '   '}`;

  return [
    `${childPrefix}${sectionBranch} changes`,
    ...changes.flatMap((entry, index) =>
      renderChangeEntry(entry, valuePrefix, index === changes.length - 1)
    ),
  ];
};

const renderCapturedEntry = (
  entry: ReviewTraceCapturedEntry,
  valuePrefix: string,
  index: number,
  arr: ReviewTraceCapturedEntry[]
): string[] => {
  const isLast = index === arr.length - 1;
  const branch = isLast ? '└─' : '├─';
  const formattedValue = indentMultilineValue(formatValue(entry.value), `${valuePrefix}${isLast ? '   ' : '│  '}   `);
  return [`${valuePrefix}${branch} ${entry.name} = ${formattedValue}`];
};

/**
 * Render lines for the captured section of a state node.
 * @param captured Array of captured entries with name and value fields
 * @param childPrefix Indentation prefix for the section header
 * @param hasSubSections Whether changes or children follow this section
 * @returns Lines for the captured section header and entries
 */
const renderCapturedSection = (
  captured: ReviewTraceCapturedEntry[],
  childPrefix: string,
  hasSubSections: boolean
): string[] => {
  const capturedBranch = hasSubSections ? '├─' : '└─';
  const capturedContinuation = hasSubSections ? '│  ' : '   ';
  const valuePrefix = `${childPrefix}${capturedContinuation}`;

  return [
    `${childPrefix}${capturedBranch} captured`,
    ...captured.flatMap((entry, index, arr) => renderCapturedEntry(entry, valuePrefix, index, arr)),
  ];
};

const renderStateNode = (node: ReviewTraceStateNode, prefix = '', isLast = true): string[] => {
  const branch = isLast ? '└─' : '├─';
  const childPrefix = `${prefix}${isLast ? '   ' : '│  '}`;
  const hasChanges = Boolean(node.changes && node.changes.length > 0);
  const hasChildren = Boolean(node.children?.length);
  const hasCaptured = Boolean(node.captured && node.captured.length > 0);
  return [
    `${prefix}${branch} ${node.frame}`,
    ...(hasCaptured ? renderCapturedSection(node.captured ?? [], childPrefix, hasChanges || hasChildren) : []),
    ...(hasChanges ? renderChangesSection(node.changes ?? [], childPrefix, hasChildren) : []),
    ...(hasChildren ? renderStateNodes(node.children ?? [], childPrefix) : []),
  ];
};

const renderStateNodes = (nodes: Array<ReviewTraceStateNode | Record<string, unknown>>, prefix = ''): string[] => {
  const normalizedNodes = nodes.map(normalizeStateNode);

  return normalizedNodes.flatMap((node, index) => renderStateNode(node, prefix, index === normalizedNodes.length - 1));
};

/**
 * Format a review call stack as a nested tree.
 * @param callStack Structured call stack nodes or legacy string frames
 * @returns Tree-like text lines or an empty array when no frames were supplied
 */
export const formatReviewCallStack = (callStack?: Array<ReviewTraceCallStackNode | string>): string[] => {
  if (!callStack?.length) {
    return [];
  }

  return renderTree(callStack, node => [node.frame]).flatMap(line => line.split('\n'));
};

/**
 * Format a legacy (non-structured) state transition object as key-value lines.
 * @param stateTransition Arbitrary key-value map representing the transition
 * @returns Flat text lines with object values indented
 */
const formatLegacyStateTransition = (stateTransition: Record<string, unknown>): string[] =>
  Object.entries(stateTransition)
    .flatMap(([key, value]) => {
      if (value && typeof value === 'object') {
        return [`${key}:`, indentMultilineValue(formatValue(value), '  ')];
      }

      return [`${key}: ${formatValue(value)}`];
    })
    .flatMap(line => line.split('\n'));

/**
 * Build lines for a structured state transition with from/to headers and step tree.
 * @param structured The structured ReviewTraceStateTransition to render
 * @returns Text lines including from/to headers and rendered state node tree
 */
const buildStructuredTransitionLines = (structured: ReviewTraceStateTransition): string[] => {
  const header: string[] = [];
  if (structured.from) {
    header.push(`from: ${structured.from}`);
  }
  if (structured.to) {
    header.push(`to: ${structured.to}`);
  }
  const separator = header.length > 0 ? [''] : [];
  return [...header, ...separator, ...renderStateNodes(structured.steps ?? [])];
};

/**
 * Format a state transition tree with frame-aligned variable changes.
 * @param stateTransition Structured transition object or legacy JSON payload
 * @returns Tree-like text lines or an empty array when no transition was supplied
 */
export const formatReviewStateTransition = (
  stateTransition?: ReviewTraceStateTransition | Record<string, unknown>
): string[] => {
  if (!stateTransition || Object.keys(stateTransition).length === 0) {
    return [];
  }
  const structured = stateTransition as ReviewTraceStateTransition;
  const lines = structured.steps?.length
    ? buildStructuredTransitionLines(structured)
    : formatLegacyStateTransition(stateTransition as Record<string, unknown>);
  return lines.flatMap(line => line.split('\n'));
};
