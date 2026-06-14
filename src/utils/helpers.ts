/**
 * General helper utilities for OpenAPI to MCP generator
 */
import { OpenAPIV3 } from 'openapi-types';

/**
 * Safely stringify a JSON object with proper error handling
 *
 * @param obj Object to stringify
 * @param defaultValue Default value to return if stringify fails
 * @returns JSON string or default value
 */
export function safeJsonStringify(obj: any, defaultValue: string = '{}'): string {
  try {
    return JSON.stringify(obj);
  } catch (e) {
    console.warn(`Failed to stringify object: ${e}`);
    return defaultValue;
  }
}

/**
 * Sanitizes a string for safe embedding inside a generated backtick template
 * literal.
 *
 * Escapes, in order:
 *  - backslashes (so subsequent escapes are not themselves re-escaped)
 *  - backticks (would otherwise close the template literal)
 *  - `${` sequences (would otherwise be evaluated as template expressions)
 *
 * The `${` escaping prevents template-literal injection: a malicious OpenAPI
 * `description`/`summary` such as `${process.env.SECRET}` is otherwise written
 * verbatim into generated code and evaluated at server startup.
 *
 * @param str String to sanitize
 * @returns Sanitized string safe for use in template literals
 */
export function sanitizeForTemplate(str: string): string {
  return (str || '').replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/**
 * Converts a string to camelCase
 *
 * @param str String to convert
 * @returns camelCase string
 */
export function toCamelCase(str: string): string {
  return str
    .replace(/(?:^\w|[A-Z]|\b\w)/g, (word, index) =>
      index === 0 ? word.toLowerCase() : word.toUpperCase()
    )
    .replace(/\s+/g, '')
    .replace(/[^a-zA-Z0-9]/g, '');
}

/**
 * Converts a string to PascalCase
 *
 * @param str String to convert
 * @returns PascalCase string
 */
export function toPascalCase(str: string): string {
  return str
    .replace(/(?:^\w|[A-Z]|\b\w)/g, (word) => word.toUpperCase())
    .replace(/\s+/g, '')
    .replace(/[^a-zA-Z0-9]/g, '');
}

/**
 * Creates a valid variable name from a string
 *
 * @param str Input string
 * @returns Valid JavaScript variable name
 */
export function toValidVariableName(str: string): string {
  // Replace non-alphanumeric characters with underscores
  const sanitized = str.replace(/[^a-zA-Z0-9_$]/g, '_');

  // Ensure the variable name doesn't start with a number
  return sanitized.match(/^[0-9]/) ? '_' + sanitized : sanitized;
}

/**
 * Checks if a string is a valid JavaScript identifier
 *
 * @param str String to check
 * @returns True if valid identifier, false otherwise
 */
export function isValidIdentifier(str: string): boolean {
  // Check if the string is a valid JavaScript identifier
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(str);
}

/**
 * Formats a string for use in code comments
 *
 * @param str String to format
 * @param maxLineLength Maximum line length
 * @returns Formatted comment string
 */
export function formatComment(str: string, maxLineLength: number = 80): string {
  if (!str) return '';

  const words = str.trim().split(/\s+/);
  const lines: string[] = [];
  let currentLine = '';

  words.forEach((word) => {
    if ((currentLine + ' ' + word).length <= maxLineLength) {
      currentLine += (currentLine ? ' ' : '') + word;
    } else {
      lines.push(currentLine);
      currentLine = word;
    }
  });

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines.join('\n * ');
}

/**
 * Normalize a value to boolean if it looks like a boolean; otherwise undefined.
 */
export function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    return undefined;
  }
  return undefined;
}

/**
 * Determine if an operation should be included in MCP generation based on x-mcp.
 * Precedence: operation > path > root; uses provided default when all undefined.
 */
export function shouldIncludeOperationForMcp(
  api: OpenAPIV3.Document,
  pathItem: OpenAPIV3.PathItemObject,
  operation: OpenAPIV3.OperationObject,
  defaultInclude: boolean = true
): boolean {
  const opRaw = (operation as any)['x-mcp'];
  const opVal = normalizeBoolean(opRaw);
  if (typeof opVal !== 'undefined') return opVal;
  if (typeof opRaw !== 'undefined') {
    console.warn(
      `Invalid x-mcp value on operation '${operation.operationId ?? '[no operationId]'}':`,
      opRaw,
      `-> expected boolean or 'true'/'false'. Falling back to path/root/default.`
    );
  }

  const pathRaw = (pathItem as any)['x-mcp'];
  const pathVal = normalizeBoolean(pathRaw);
  if (typeof pathVal !== 'undefined') return pathVal;
  if (typeof pathRaw !== 'undefined') {
    console.warn(
      `Invalid x-mcp value on path item:`,
      pathRaw,
      `-> expected boolean or 'true'/'false'. Falling back to root/default.`
    );
  }

  const rootRaw = (api as any)['x-mcp'];
  const rootVal = normalizeBoolean(rootRaw);
  if (typeof rootVal !== 'undefined') return rootVal;
  if (typeof rootRaw !== 'undefined') {
    console.warn(
      `Invalid x-mcp value at API root:`,
      rootRaw,
      `-> expected boolean or 'true'/'false'. Falling back to defaultInclude=${defaultInclude}.`
    );
  }

  return defaultInclude;
}
