/**
 * JSON formatting rules appended to every prompt that requests JSON output.
 * Prevents literal-newline errors that make AI responses unparseable.
 */
export const JSON_OUTPUT_RULES = `IMPORTANT: Minify the JSON — no unnecessary whitespace or newlines.
JSON string values MUST NOT contain literal newline characters (line breaks). A literal newline inside a JSON string value makes the entire response unparseable. Use the escape sequence \\n if a string value must represent a line break.

INVALID — literal newline inside a string value:
{"summary": "Fix the
context file"}

VALID:
{"summary": "Fix the context file"}` as const;
