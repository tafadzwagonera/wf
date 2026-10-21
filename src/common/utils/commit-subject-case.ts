const PREFIX_RE = /^(?:[A-Za-z][A-Za-z0-9]*-\d+:\s+)?(?:[a-z]+(?:\([^)]*\))?!?:\s+)?/;

export const splitSubjectPrefix = (subject: string): { prefix: string; description: string } => {
  const match = PREFIX_RE.exec(subject);
  const prefix = match ? match[0] : '';
  return { prefix, description: subject.slice(prefix.length) };
};

export const capitalizeCommitMessageDescription = (message: string): string => {
  const newlineIdx = message.indexOf('\n');
  const firstLine = newlineIdx === -1 ? message : message.slice(0, newlineIdx);
  const rest = newlineIdx === -1 ? '' : message.slice(newlineIdx);
  const { prefix, description } = splitSubjectPrefix(firstLine);
  if (!description || !/^[a-z]/.test(description)) return message;
  return prefix + description[0].toUpperCase() + description.slice(1) + rest;
};

export const violatesUppercaseDescription = (subject: string): boolean => {
  const { description } = splitSubjectPrefix(subject);
  return /^[a-z]/.test(description);
};
