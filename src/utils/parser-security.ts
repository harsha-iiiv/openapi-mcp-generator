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
export function assertNoExternalRefs(node: unknown, seen: WeakSet<object> = new WeakSet()): void {
  if (node === null || typeof node !== 'object') return;
  if (seen.has(node as object)) return;
  seen.add(node as object);

  if (Array.isArray(node)) {
    for (const item of node) assertNoExternalRefs(item, seen);
    return;
  }

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === '$ref' && isExternalHttpRef(value)) {
      throw new ExternalRefError(value);
    }
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
  if (allowExternalRefs) {
    return (await SwaggerParser.dereference(input as string)) as OpenAPIV3.Document;
  }

  // Resolve local + internal refs only; never follow http(s).
  const resolverOptions = {
    resolve: {
      http: false as const,
    },
  };

  // Parse without dereferencing so we can inspect raw $ref values first.
  const parsed = (await SwaggerParser.parse(
    input as string,
    resolverOptions
  )) as OpenAPIV3.Document;
  assertNoExternalRefs(parsed);

  return (await SwaggerParser.dereference(input as string, resolverOptions)) as OpenAPIV3.Document;
}
