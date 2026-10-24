/**
 * Generator for configuration files for MCP servers
 */

/**
 * Generates the content of tsconfig.json for the MCP server
 *
 * @returns JSON string for tsconfig.json
 */
export function generateTsconfigJson(): string {
  const tsconfigData = {
    compilerOptions: {
      esModuleInterop: true,
      skipLibCheck: true,
      target: 'ES2022',
      allowJs: true,
      resolveJsonModule: true,
      moduleDetection: 'force',
      strict: true,
      noImplicitAny: true,
      strictNullChecks: true,
      module: 'Node16',
      moduleResolution: 'Node16',
      noEmit: false,
      rootDir: './src',
      outDir: './build',
      declaration: true,
      sourceMap: true,
      forceConsistentCasingInFileNames: true,
      // Explicit, because TypeScript 6+ no longer includes every @types package by default.
      types: ['node'],
    },
    include: ['src/**/*'],
    exclude: ['node_modules', 'build', '**/*.test.ts'],
  };

  return JSON.stringify(tsconfigData, null, 2);
}

/**
 * Generates the content of .gitignore for the MCP server
 *
 * @returns Content for .gitignore
 */
export function generateGitignore(): string {
  return `# Dependencies
node_modules
.pnp
.pnp.js

# Build outputs
dist
build
logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
lerna-debug.log*
.pnpm-debug.log*

# Reports
report.[0-9]*.[0-9]*.[0-9]*.[0-9]*.json

# Runtime data
pids
*.pid
*.seed
*.pid.lock

# Coverage
coverage
*.lcov
.nyc_output

# Build artifacts
.grunt
bower_components
jspm_packages/
web_modules/
.lock-wscript

# Editor settings
.vscode/*
!.vscode/settings.json
!.vscode/tasks.json
!.vscode/launch.json
!.vscode/extensions.json
*.code-workspace
.idea
*.sublime-workspace
*.sublime-project

# Caches
.eslintcache
.stylelintcache
.node_repl_history
.browserslistcache

# Environment variables
.env
.env.local
.env.development.local
.env.test.local
.env.production.local

# OS specific
.DS_Store
Thumbs.db
`;
}

/**
 * Generates the content of .prettierrc for the MCP server
 *
 * @returns JSON string for .prettierrc
 */
export function generatePrettierConfig(): string {
  const prettierConfig = {
    semi: true,
    trailingComma: 'es5',
    singleQuote: true,
    printWidth: 100,
    tabWidth: 2,
  };

  return JSON.stringify(prettierConfig, null, 2);
}
