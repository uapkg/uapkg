export interface PackOptions {
  cwd?: string;
  ignoreScripts?: boolean;
  resolveNode?: (selector: string, workspaceRoot: string) => Promise<string>;
  nodeExecutable?: string;
  outFile?: string;
  dryRun?: boolean;
  allowMissingLfs?: boolean;
}

export interface PackResult {
  pluginRoot: string;
  archivePath: string;
  integrityPath?: string;
  files: string[];
  warnings: string[];
  dryRun: boolean;
}

export interface PackManifest {
  name: string;
  version: string;
  integration?: { entry?: string };
  lifecycle?: { scripts?: { prepack?: string; postinstall?: string }; runtime?: { node: string } };
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
  overrides?: Record<string, unknown>;
}

export interface CollectedFile {
  absolutePath: string;
  relativePath: string;
}

export interface IgnoreRuleSet {
  gitRoot: string;
  ruleFiles: string[];
}
