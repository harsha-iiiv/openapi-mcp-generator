/**
 * Parser-level security utilities.
 *
 * Guards against SSRF via uncontrolled external `$ref` resolution. By default
 * `@apidevtools/swagger-parser`'s `dereference()` will follow `http://` and
 * `https://` `$ref` URLs, issuing live outbound requests during parsing. A
 * malicious or compromised spec can use this to reach internal services
 * (cloud metadata endpoints, internal APIs) from the host running the
 * generator. See GitHub issue #68.
 */
import SwaggerParser from '@apidevtools/swagger-parser';
import { OpenAPIV3 } from 'openapi-types';

/** Error thrown when an external `$ref` is encountered but not allowed. */
export class ExternalRefError extends Error {
  constructor(public readonly ref: string) {
    super(
      `External $ref resolution is disabled for security (SSRF protection): "${ref}". ` +
        `Re-run with --allow-external-refs / { allowExternalRefs: true } to permit it.`
    );
    this.name = 'ExternalRefError';
  }
}

/** Returns true if a `$ref` string points at an http(s) URL. */
export function isExternalHttpRef(ref: unknown): ref is string {
  return typeof ref === 'string' && /^https?:\/\//i.test(ref.trim());
}

/**
 * Recursively scan an already-loaded spec object for external http(s) `$ref`
 * values. Throws {@link ExternalRefError} on the first one found.
 *
 * This runs before dereferencing so no outbound request is ever made.
 */
/**
 * Keys whose values are literal user data (example payloads, defaults), where a
 * string property named `$ref` is content — not an OpenAPI reference. We don't
 * scan into these to avoid false positives on otherwise-valid specs.
 */
const DATA_BEARING_KEYS = new Set(['example', 'examples', 'default']);

/**
 * An OpenAPI Reference Object is `{ $ref: string }`, optionally accompanied by
 * `summary`/`description` (OpenAPI 3.1). If an object carries a `$ref` string
 * alongside other arbitrary properties, it's user data (e.g. an example body),
 * not a reference SwaggerParser would resolve.
 */
function isReferenceObject(obj: Record<string, unknown>): boolean {
  if (typeof obj.$ref !== 'string') return false;
  return Object.keys(obj).every((k) => k === '$ref' || k === 'summary' || k === 'description');
}

export function assertNoExternalRefs(node: unknown, seen: WeakSet<object> = new WeakSet()): void {
  if (node === null || typeof node !== 'object') return;
  if (seen.has(node as object)) return;
  seen.add(node as object);

  if (Array.isArray(node)) {
    for (const item of node) assertNoExternalRefs(item, seen);
    return;
  }

  const obj = node as Record<string, unknown>;

  // Only treat a structurally-valid Reference Object's $ref as a resolvable ref.
  if (isReferenceObject(obj) && isExternalHttpRef(obj.$ref)) {
    throw new ExternalRefError(obj.$ref as string);
  }

  for (const [key, value] of Object.entries(obj)) {
    // Skip literal-data subtrees where `$ref` would be content, not a reference.
    if (DATA_BEARING_KEYS.has(key)) continue;
    assertNoExternalRefs(value, seen);
  }
}

/**
 * Parse and dereference an OpenAPI spec with optional SSRF protection.
 *
 * When `allowExternalRefs` is false (the default), the spec is first parsed
 * without resolving external references, scanned for external http(s) refs,
 * and only then dereferenced with the http resolver disabled.
 *
 * @param input Path, URL, or pre-parsed document
 * @param allowExternalRefs Permit external http(s) `$ref` resolution
 * @returns Fully dereferenced OpenAPI v3 document
 */
export async function parseSpecSecurely(
  input: string | OpenAPIV3.Document,
  allowExternalRefs: boolean
): Promise<OpenAPIV3.Document> {
  // SwaggerParser accepts a path/URL string OR a pre-parsed API object.
  const apiInput = input as Parameters<typeof SwaggerParser.dereference>[0];

  if (allowExternalRefs) {
    return (await SwaggerParser.dereference(apiInput)) as OpenAPIV3.Document;
  }

  // Resolve local + internal refs only; never follow http(s).
  const resolverOptions = {
    resolve: {
      http: false as const,
    },
  };

  // Parse without dereferencing so we can inspect raw $ref values first.
  const parsed = (await SwaggerParser.parse(apiInput, resolverOptions)) as OpenAPIV3.Document;
  assertNoExternalRefs(parsed);

  return (await SwaggerParser.dereference(apiInput, resolverOptions)) as OpenAPIV3.Document;
}
