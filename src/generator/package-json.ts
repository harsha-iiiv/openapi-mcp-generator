import { CliOptions } from '../types/index.js';

/**
 * Generates the content of package.json for the MCP server
 *
 * @param serverName Server name
 * @param serverVersion Server version
 * @param options CLI options
 * @returns JSON string for package.json
 */
export function generatePackageJson(
  serverName: string,
  serverVersion: string,
  options: CliOptions
): string {
  const transportType = options.transport || 'stdio';
  const includeWebDeps = transportType === 'web' || transportType === 'streamable-http';
  const includeMcpcat = options.withMcpcat || options.withOtel;

  const packageData: any = {
    name: serverName,
    version: serverVersion,
    description: `MCP Server generated from OpenAPI spec for ${serverName}`,
    private: true,
    type: 'module',
    main: 'build/index.js',
    files: ['build', 'src'],
    scripts: {
      start: 'node build/index.js',
      build: 'tsc && shx chmod 755 build/index.js',
      typecheck: 'tsc --noEmit',
      prestart: 'npm run build',
    },
    engines: {
      node: '>=20.0.0',
    },
    dependencies: {
      '@modelcontextprotocol/sdk': '^1.10.0',
      axios: '^1.9.0',
      dotenv: '^16.4.5',
      zod: '^3.24.3',
      'json-schema-to-zod': '^2.6.1',
      ...(includeMcpcat ? { mcpcat: '^0.1.5' } : {}),
    },
    devDependencies: {
      '@types/node': '^22.15.2',
      typescript: '^5.8.3',
      shx: '^0.4.0',
    },
  };

  // Add Hono dependencies for web-based transports
  if (includeWebDeps) {
    packageData.dependencies = {
      ...packageData.dependencies,
      hono: '^4.7.7',
      '@hono/node-server': '^1.14.1',
      uuid: '^11.1.0',
    };

    packageData.devDependencies = {
      ...packageData.devDependencies,
      '@types/uuid': '^10.0.0',
    };

    // Add appropriate start script based on transport type
    if (transportType === 'web') {
      packageData.scripts['start:web'] = 'node build/index.js --transport=web';
    } else if (transportType === 'streamable-http') {
      packageData.scripts['start:http'] = 'node build/index.js --transport=streamable-http';
      packageData.dependencies['fetch-to-node'] = '^2.1.0';
    }
  }

  return JSON.stringify(packageData, null, 2);
}
