import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultServerConditions, defineConfig } from 'vite-plus';
import { importPolicyOverrides } from './tools/import-policy/policy.ts';

const workspacePath = (relativePath: string): string => fileURLToPath(new URL(relativePath, import.meta.url));
const sourceConditions = ['uapkg-source', ...defaultServerConditions];

interface WorkspaceBuildPackage {
  readonly name: string;
  readonly directory: string;
  readonly dependencies: readonly string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function discoverWorkspaceBuildPackages(): WorkspaceBuildPackage[] {
  const packagesDirectory = workspacePath('./packages');
  const discovered = readdirSync(packagesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const manifestPath = path.join(packagesDirectory, entry.name, 'package.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
      if (!isObject(manifest) || typeof manifest.name !== 'string' || !manifest.name.startsWith('@uapkg/')) {
        throw new Error(`Invalid UAPKG workspace manifest: ${manifestPath}`);
      }

      return {
        name: manifest.name,
        directory: entry.name,
        dependencyNames: isObject(manifest.dependencies) ? Object.keys(manifest.dependencies) : [],
      };
    });

  const workspaceNames = new Set(discovered.map(({ name }) => name));
  return discovered
    .map(({ name, directory, dependencyNames }) => ({
      name,
      directory,
      dependencies: dependencyNames.filter((dependency) => workspaceNames.has(dependency)).sort(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

const workspaceBuildPackages = discoverWorkspaceBuildPackages();
const cliBuildPackage = workspaceBuildPackages.find(({ name }) => name === '@uapkg/cli');
if (!cliBuildPackage) {
  throw new Error('The @uapkg/cli workspace package is required');
}

const libraryBuildPackages = workspaceBuildPackages.filter(({ name }) => name !== '@uapkg/cli');
const libraryBuildNames = new Set(libraryBuildPackages.map(({ name }) => name));
const packTaskName = (packageName: string): string => `pack:${packageName.slice('@uapkg/'.length)}`;

const libraryPackTasks = Object.fromEntries(
  libraryBuildPackages.map((pkg) => [
    packTaskName(pkg.name),
    {
      command: 'vp pack',
      cwd: `packages/${pkg.directory}`,
      dependsOn: pkg.dependencies.filter((dependency) => libraryBuildNames.has(dependency)).map(packTaskName),
      input: [
        { auto: true },
        { pattern: '!**/coverage/**', base: 'workspace' as const },
        { pattern: `!packages/${pkg.directory}/dist/**`, base: 'workspace' as const },
      ],
      // Explicit outputs prevent transient or concurrently observed workspace writes from entering Vite Task archives.
      output: [{ pattern: `packages/${pkg.directory}/dist/**`, base: 'workspace' as const }],
    },
  ]),
);

const sourceAliases = [
  {
    find: '@uapkg/diagnostics-format/ink',
    replacement: workspacePath('./packages/uapkg-diagnostics-format/src/ink/index.ts'),
  },
  {
    find: '@uapkg/package-claims/schema',
    replacement: workspacePath('./packages/uapkg-package-claims/src/schema/index.ts'),
  },
  { find: '@uapkg/cli', replacement: workspacePath('./packages/uapkg/src/index.ts') },
  { find: '@uapkg/common', replacement: workspacePath('./packages/uapkg-common/src/index.ts') },
  { find: '@uapkg/common-schema', replacement: workspacePath('./packages/uapkg-common-schema/src/index.ts') },
  { find: '@uapkg/config', replacement: workspacePath('./packages/uapkg-config/src/index.ts') },
  { find: '@uapkg/diagnostics', replacement: workspacePath('./packages/uapkg-diagnostics/src/index.ts') },
  {
    find: '@uapkg/diagnostics-format',
    replacement: workspacePath('./packages/uapkg-diagnostics-format/src/index.ts'),
  },
  { find: '@uapkg/installer', replacement: workspacePath('./packages/uapkg-installer/src/index.ts') },
  { find: '@uapkg/log', replacement: workspacePath('./packages/uapkg-log/src/index.ts') },
  { find: '@uapkg/pack', replacement: workspacePath('./packages/uapkg-pack/src/index.ts') },
  {
    find: '@uapkg/package-claims',
    replacement: workspacePath('./packages/uapkg-package-claims/src/index.ts'),
  },
  {
    find: '@uapkg/package-manifest',
    replacement: workspacePath('./packages/uapkg-package-manifest/src/index.ts'),
  },
  {
    find: '@uapkg/package-manifest-schema',
    replacement: workspacePath('./packages/uapkg-package-manifest-schema/src/index.ts'),
  },
  { find: '@uapkg/registry-core', replacement: workspacePath('./packages/uapkg-registry-core/src/index.ts') },
  {
    find: '@uapkg/registry-schema',
    replacement: workspacePath('./packages/uapkg-registry-schema/src/index.ts'),
  },
  { find: '@uapkg/registry-tools', replacement: workspacePath('./packages/uapkg-registry-tools/src/index.ts') },
];

interface TestProjectOptions {
  readonly hookTimeout?: number;
  readonly testTimeout?: number;
}

const testProject = (name: string, relativeRoot: string, options: TestProjectOptions = {}) => ({
  root: workspacePath(relativeRoot),
  resolve: { alias: sourceAliases, conditions: sourceConditions },
  ssr: { resolve: { conditions: sourceConditions } },
  test: {
    name,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    ...options,
  },
});

export default defineConfig({
  fmt: {
    ignorePatterns: [
      '**/node_modules/**',
      '**/.pnpm-store/**',
      '**/dist/**',
      '**/coverage/**',
      '**/__snapshots__/**',
      'launcher/target/**',
    ],
    useTabs: false,
    tabWidth: 2,
    printWidth: 120,
    singleQuote: true,
    semi: true,
    trailingComma: 'all',
    sortPackageJson: false,
    endOfLine: 'lf',
    insertFinalNewline: true,
  },
  lint: {
    ignorePatterns: [
      '**/node_modules/**',
      '**/.pnpm-store/**',
      '**/dist/**',
      '**/coverage/**',
      '**/__snapshots__/**',
      'launcher/target/**',
    ],
    categories: { correctness: 'error' },
    plugins: ['eslint', 'oxc', 'typescript', 'unicorn', 'node', 'react'],
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    env: { node: true },
    rules: {
      'typescript/no-deprecated': 'error',
      'vite-plus/prefer-vite-plus-imports': 'error',
    },
    overrides: importPolicyOverrides,
    options: {
      reportUnusedDisableDirectives: 'error',
      typeAware: true,
      typeCheck: true,
    },
  },
  pack: {
    entry: ['src/**/*.ts', 'src/**/*.tsx', '!src/**/*.d.ts'],
    root: 'src',
    outDir: 'dist',
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    tsconfig: 'tsconfig.pack.json',
    fixedExtension: false,
    unbundle: true,
    dts: { generator: 'tsgo', sourcemap: true },
    sourcemap: true,
    clean: true,
    minify: false,
    deps: { neverBundle: true },
    inputOptions: { resolve: { conditionNames: ['uapkg-source', 'node', 'import', 'default'] } },
  },
  resolve: { alias: sourceAliases, conditions: sourceConditions },
  ssr: { resolve: { conditions: sourceConditions } },
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.{ts,tsx}', 'tools/**/*.ts'],
      exclude: ['**/*.test.ts', '**/tests/**', '**/node_modules/**', '**/dist/**'],
      reporter: ['text', 'lcov', 'json', 'html'],
    },
    projects: [
      testProject('@uapkg/cli', './packages/uapkg', { hookTimeout: 15_000, testTimeout: 15_000 }),
      testProject('@uapkg/common', './packages/uapkg-common'),
      testProject('@uapkg/common-schema', './packages/uapkg-common-schema'),
      testProject('@uapkg/config', './packages/uapkg-config'),
      testProject('@uapkg/diagnostics', './packages/uapkg-diagnostics'),
      testProject('@uapkg/diagnostics-format', './packages/uapkg-diagnostics-format'),
      testProject('@uapkg/installer', './packages/uapkg-installer'),
      testProject('@uapkg/log', './packages/uapkg-log'),
      testProject('@uapkg/pack', './packages/uapkg-pack'),
      testProject('@uapkg/package-claims', './packages/uapkg-package-claims'),
      testProject('@uapkg/package-manifest', './packages/uapkg-package-manifest'),
      testProject('@uapkg/package-manifest-schema', './packages/uapkg-package-manifest-schema'),
      testProject('@uapkg/registry-core', './packages/uapkg-registry-core'),
      testProject('@uapkg/registry-schema', './packages/uapkg-registry-schema'),
      testProject('@uapkg/registry-tools', './packages/uapkg-registry-tools'),
      testProject('consumer-bundle-tools', './tools/consumer-bundle'),
      testProject('dev-build-tools', './tools/dev-build'),
      testProject('import-policy-tools', './tools/import-policy'),
      testProject('release-tools', './tools/release', { hookTimeout: 30_000, testTimeout: 30_000 }),
    ],
  },
  run: {
    cache: {
      scripts: false,
      tasks: true,
    },
    tasks: {
      ...libraryPackTasks,
      'pack:libraries': {
        command: 'node -e "void 0"',
        cache: false,
        dependsOn: libraryBuildPackages.map(({ name }) => packTaskName(name)),
      },
      'cli:build': {
        command: 'node build/runCliBuild.ts',
        cwd: 'packages/uapkg',
        dependsOn: cliBuildPackage.dependencies
          .filter((dependency) => libraryBuildNames.has(dependency))
          .map(packTaskName),
        input: [
          { auto: true },
          { pattern: '!**/coverage/**', base: 'workspace' },
          { pattern: '!packages/uapkg/dist/**', base: 'workspace' },
        ],
        output: [{ pattern: 'packages/uapkg/dist/**', base: 'workspace' }],
      },
    },
  },
  staged: {
    '*': 'vp check --fix',
  },
});
