const escapeRegExp = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

export const mentionsPath = (text: string, filePath: string): boolean =>
  new RegExp(`(?<![\\w./-])(?:\\./)?${escapeRegExp(filePath)}(?![\\w-]|\\.\\w)`).test(text);
