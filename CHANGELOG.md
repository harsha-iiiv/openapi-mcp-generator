# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- CLI option `--passthrough-auth` to forward authentication headers from MCP requests to the downstream API, per the OpenAPI security scheme. Supports http (bearer/basic), apiKey (header/query/cookie), and OpenID Connect bearer tokens. Works for SSE and StreamableHTTP transports. Requires `@modelcontextprotocol/sdk` ^1.17.4.


## [3.2.0] - 2025-08-24

### Added

- Endpoint filtering using `x-mcp` OpenAPI extension to control which operations are exposed as MCP tools
- CLI option `--default-include` to change default behavior for endpoint inclusion
- Precedence rules for `x-mcp` extension (operation > path > root level)
- Enhanced programmatic API with `defaultInclude` option in `getToolsFromOpenApi`

### Changed

- Improved documentation with examples for endpoint filtering and OpenAPI extensions.
- Version bump to next minor release
- Updated package version to reflect accumulated features and improvements

## [3.1.4] - 2025-06-18

### Chores

- Updated the application version to 3.1.4 and ensured the CLI displays the version dynamically.

### Style

- Improved code formatting for better readability.

### Bug Fixes

- Tool names now retain their original casing during extraction.

## [3.1.3] - 2025-06-12

### Fixed

- Cannot find the package after building and the problem during the building.

## [3.1.2] - 2025-06-08

### Fixed

- Prevent stack overflow (RangeError: Maximum call stack size exceeded) when processing recursive or cyclic OpenAPI schemas (e.g., self-referencing objects).
- Added cycle detection to schema mapping, ensuring robust handling of recursive structures.

## [3.1.1] - 2025-05-26

### Added

- Introduced a new executable command-line script for easier usage in Unix-like environments.

### Changed

- Use new CLI entry point to use the new `bin/openapi-mcp-generator.js` file.
- Updated build script to ensure the new CLI file has the correct permissions.
- Refactored `index.ts` to streamline argument parsing and error handling.

## [3.1.0] - 2025-05-18

### Added

- Programmatic API to extract MCP tool definitions from OpenAPI specs
- New exportable `getToolsFromOpenApi` function for direct integration in code
- Advanced filtering capabilities for programmatic tool extraction
- Comprehensive documentation in PROGRAMMATIC_API.md
- Updated README with programmatic API usage examples

### Changed

- Improved module structure with better exports
- Enhanced detection of module execution context

## [3.0.0] - 2025-04-26

### Added

- Streamable HTTP support for OpenAPI MCP generator, enabling efficient handling of large payloads and real-time data transfer.
- Major architectural refactor to support streaming responses and requests.

### Fixed

- Multiple bugs related to HTTP/HTTPS connection handling, stream closure, and error propagation in streaming scenarios.
- Fixed resource leak issues on server aborts and client disconnects during streaming.

### Changed

- Major version bump due to breaking changes in API and internal structures to support streaming.
- Updated documentation to reflect new streaming capabilities and usage instructions.
- Enhanced performance and robustness of HTTP/HTTPS transport layers.

## [2.0.0] - 2025-04-12

### Added

- Runtime argument validation using Zod
- JSON Schema to Zod schema conversion
- Improved error handling and formatting
- TypeScript strict mode enabled
- Buildable project structure with proper TypeScript configuration
- Enhanced project documentation
- Better support for OpenAPI request body handling
- Support for multiple content types

### Changed

- Simplified transport layer to only support stdio transport
- Removed support for WebSocket and HTTP transports
- Updated to use @modelcontextprotocol/sdk v1.9.0
- Improved CLI interface with better error messages
- Enhanced type safety throughout the codebase
- Better handling of path parameters and query strings
- More robust OpenAPI schema processing

### Fixed

- Path parameter resolution in URLs
- Content-Type header handling
- Response processing for different content types
- Schema validation error messages
- Building and packaging issues

## [1.0.0] - Initial Release

### Added

- Basic OpenAPI to MCP server generation
- Support for GET, POST, PUT, DELETE methods
- Basic error handling
- Simple CLI interface
- Basic TypeScript support
