import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'semver';
import { createDevelopmentPath, isDevelopmentPathSnapshot, type DevelopmentPath } from './DevelopmentPath.ts';
import type { DevelopmentInstallReceipt, NativeInstallStatus, NativeLinkSnapshot } from './types.ts';

interface NativeInstallationOptions {
  homeDirectory?: string;
  nodePath?: string;
  platform?: NodeJS.Platform;
  pathManager?: DevelopmentPath;
}

/** Owns the development executable, receipt, and PATH entry recorded at link time. */
export class NativeDevInstallation {
  readonly binDirectory: string;
  readonly executablePath: string;
  readonly receiptPath: string;
  readonly snapshotPath: string;
  readonly workspaceRoot: string;
  private readonly stateDirectory: string;
  private readonly nodePath: string;
  private readonly pathManager: DevelopmentPath;

  constructor(workspaceRoot: string, options: NativeInstallationOptions = {}) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.binDirectory = path.join(path.resolve(options.homeDirectory ?? os.homedir()), '.uapkg-development', 'bin');
    this.executablePath = path.join(
      this.binDirectory,
      (options.platform ?? process.platform) === 'win32' ? 'uapkg.exe' : 'uapkg',
    );
    this.receiptPath = path.join(this.binDirectory, 'uapkg-install.json');
    this.stateDirectory = path.join(this.workspaceRoot, 'tools', 'dev-build', '.state', 'native-uapkg');
    this.snapshotPath = path.join(this.stateDirectory, 'snapshot.json');
    this.nodePath = path.resolve(options.nodePath ?? process.execPath);
    this.pathManager = options.pathManager ?? createDevelopmentPath();
  }

  link(builtExecutable: string, force = false): boolean {
    const enginePath = path.join(this.workspaceRoot, 'packages', 'uapkg', 'dist', 'cli.js');
    const packagePath = path.join(this.workspaceRoot, 'packages', 'uapkg', 'package.json');
    this.requireFile(builtExecutable);
    this.requireFile(enginePath);
    this.requireFile(this.nodePath);
    const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { version?: unknown };
    const parsedVersion = typeof manifest.version === 'string' ? parse(manifest.version) : null;
    const canonicalVersion = parsedVersion
      ? `${parsedVersion.version}${parsedVersion.build.length ? `+${parsedVersion.build.join('.')}` : ''}`
      : null;
    if (typeof manifest.version !== 'string' || canonicalVersion !== manifest.version) {
      throw new Error('[dev-build] The CLI package must have an exact semantic version.');
    }
    const receipt: DevelopmentInstallReceipt = {
      schemaVersion: 1,
      installMethod: 'development',
      defaultCliVersion: manifest.version,
      development: { enginePath, nodePath: this.nodePath, checkoutPath: this.workspaceRoot },
    };
    const binary = fs.readFileSync(builtExecutable);
    const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);

    let pathChanged = false;
    this.withLock(() => {
      const previousBinary = this.readOptionalFile(this.executablePath);
      const previousReceipt = this.readOptionalFile(this.receiptPath);
      const existingSnapshot = this.readSnapshot();
      const owned = this.matchesSnapshot(existingSnapshot, previousBinary, previousReceipt);
      if (existingSnapshot && !owned) {
        throw new Error(
          '[dev-build] The native installation changed since linking. Its saved restore state was retained; inspect build:status before replacing it.',
        );
      }
      if (!existingSnapshot && (previousBinary || previousReceipt) && !force) {
        throw new Error(
          '[dev-build] A native UAPKG installation already exists. Use build:link -- --force to save it and temporarily replace it.',
        );
      }

      const previousSnapshot = this.readOptionalFile(this.snapshotPath);
      const previousPath = this.pathManager.capture(this.binDirectory);

      fs.mkdirSync(this.stateDirectory, { recursive: true });
      if (!existingSnapshot) {
        this.saveBackup('previous-binary', previousBinary);
        this.saveBackup('previous-receipt', previousReceipt);
      }
      const snapshot: NativeLinkSnapshot = {
        schemaVersion: 2,
        checkoutPath: this.workspaceRoot,
        binDirectory: this.binDirectory,
        previousBinary: existingSnapshot?.previousBinary ?? previousBinary !== null,
        previousReceipt: existingSnapshot?.previousReceipt ?? previousReceipt !== null,
        previousBinaryHash: existingSnapshot
          ? existingSnapshot.previousBinaryHash
          : previousBinary
            ? digest(previousBinary)
            : null,
        previousReceiptHash: existingSnapshot
          ? existingSnapshot.previousReceiptHash
          : previousReceipt
            ? digest(previousReceipt)
            : null,
        installedBinaryHash: digest(binary),
        installedReceiptHash: digest(receiptBytes),
        path: existingSnapshot?.path ?? previousPath,
      };

      this.replacePair(binary, receiptBytes);
      let pathAttempted = false;
      try {
        this.writeAtomic(this.snapshotPath, Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`));
        // Persist ownership and the original PATH baseline before changing PATH.
        pathAttempted = true;
        pathChanged = this.pathManager.add(this.binDirectory);
      } catch (error) {
        const failures: unknown[] = [];
        try {
          if (pathAttempted) this.pathManager.restore(this.binDirectory, previousPath);
        } catch (restoreError) {
          failures.push(restoreError);
        }
        let pairRestored = false;
        try {
          this.replacePair(previousBinary, previousReceipt);
          pairRestored = true;
        } catch (restoreError) {
          failures.push(restoreError);
        }
        if (pairRestored && (failures.length === 0 || previousSnapshot !== null)) {
          try {
            this.replaceFile(this.snapshotPath, previousSnapshot, false);
          } catch (restoreError) {
            failures.push(restoreError);
          }
        }
        if (failures.length > 0)
          throw new AggregateError(
            [error, ...failures],
            '[dev-build] Linking failed and rollback could not finish. The PATH baseline and restore files were retained.',
          );
        throw error;
      }
    });
    return pathChanged;
  }

  unlink(): boolean {
    if (!fs.existsSync(this.snapshotPath)) return false;
    let pathChanged = false;
    this.withLock(() => {
      const snapshot = this.readSnapshot();
      const currentBinary = this.readOptionalFile(this.executablePath);
      const currentReceipt = this.readOptionalFile(this.receiptPath);
      // A completed restore may still have its snapshot after interrupted cleanup.
      const restored =
        snapshot !== null &&
        (currentBinary === null ? null : digest(currentBinary)) === snapshot.previousBinaryHash &&
        (currentReceipt === null ? null : digest(currentReceipt)) === snapshot.previousReceiptHash;
      if (!snapshot || (!this.matchesSnapshot(snapshot, currentBinary, currentReceipt) && !restored)) {
        throw new Error(
          '[dev-build] This checkout no longer owns the native installation. No installed files were changed; the restore snapshot was retained.',
        );
      }
      const binary = snapshot.previousBinary ? this.readBackup('previous-binary', snapshot.previousBinaryHash) : null;
      const receipt = snapshot.previousReceipt
        ? this.readBackup('previous-receipt', snapshot.previousReceiptHash)
        : null;
      const previousPath = this.pathManager.capture(this.binDirectory);
      try {
        pathChanged = this.pathManager.restore(this.binDirectory, snapshot.path);
        this.replacePair(binary, receipt);
      } catch (error) {
        try {
          if (previousPath.preexisting) this.pathManager.add(this.binDirectory);
          else this.pathManager.restore(this.binDirectory, previousPath);
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            '[dev-build] Unlinking failed and PATH rollback could not finish. The restore snapshot was retained.',
          );
        }
        throw error;
      }
      fs.unlinkSync(this.snapshotPath);
      for (const name of ['previous-binary', 'previous-receipt']) {
        fs.rmSync(path.join(this.stateDirectory, name), { force: true });
      }
    });
    return pathChanged;
  }

  status(): NativeInstallStatus {
    const binary = this.readOptionalFile(this.executablePath);
    const receiptBytes = this.readOptionalFile(this.receiptPath);
    const snapshot = this.readSnapshot();
    return {
      binDirectory: this.binDirectory,
      executablePath: this.executablePath,
      receiptPath: this.receiptPath,
      snapshotPath: this.snapshotPath,
      installed: binary !== null,
      owned: this.matchesSnapshot(snapshot, binary, receiptBytes),
      receipt: this.parseDevelopmentReceipt(receiptBytes),
    };
  }

  private parseDevelopmentReceipt(bytes: Buffer | null): DevelopmentInstallReceipt | null {
    if (!bytes) return null;
    try {
      const value = JSON.parse(bytes.toString('utf8')) as Partial<DevelopmentInstallReceipt>;
      if (value.schemaVersion !== 1 || value.installMethod !== 'development' || !value.development) return null;
      const development = value.development;
      if (
        [development.checkoutPath, development.enginePath, development.nodePath].some(
          (entry) => typeof entry !== 'string' || !path.isAbsolute(entry),
        )
      )
        return null;
      return value as DevelopmentInstallReceipt;
    } catch {
      return null;
    }
  }

  private readSnapshot(): NativeLinkSnapshot | null {
    if (!fs.existsSync(this.snapshotPath)) return null;
    const snapshot = JSON.parse(fs.readFileSync(this.snapshotPath, 'utf8')) as NativeLinkSnapshot;
    if (
      snapshot.schemaVersion !== 2 ||
      snapshot.checkoutPath !== this.workspaceRoot ||
      snapshot.binDirectory !== this.binDirectory ||
      typeof snapshot.previousBinary !== 'boolean' ||
      typeof snapshot.previousReceipt !== 'boolean' ||
      (snapshot.previousBinary
        ? typeof snapshot.previousBinaryHash !== 'string'
        : snapshot.previousBinaryHash !== null) ||
      (snapshot.previousReceipt
        ? typeof snapshot.previousReceiptHash !== 'string'
        : snapshot.previousReceiptHash !== null) ||
      typeof snapshot.installedBinaryHash !== 'string' ||
      typeof snapshot.installedReceiptHash !== 'string' ||
      !isDevelopmentPathSnapshot(snapshot.path) ||
      snapshot.path.directory !== this.binDirectory
    ) {
      throw new Error(`[dev-build] Invalid native restore snapshot: ${this.snapshotPath}`);
    }
    return snapshot;
  }

  private matchesSnapshot(snapshot: NativeLinkSnapshot | null, binary: Buffer | null, receipt: Buffer | null): boolean {
    return (
      snapshot !== null &&
      binary !== null &&
      receipt !== null &&
      digest(binary) === snapshot.installedBinaryHash &&
      digest(receipt) === snapshot.installedReceiptHash
    );
  }

  private requireFile(filePath: string): void {
    if (!fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`[dev-build] Required build file is missing: ${filePath}`);
    }
  }

  private readOptionalFile(filePath: string): Buffer | null {
    const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`[dev-build] Refusing to replace a non-regular installation file: ${filePath}`);
    }
    return fs.readFileSync(filePath);
  }

  private saveBackup(name: string, bytes: Buffer | null): void {
    const filePath = path.join(this.stateDirectory, name);
    if (bytes) this.writeAtomic(filePath, bytes);
    else fs.rmSync(filePath, { force: true });
  }

  private readBackup(name: string, expectedHash: string | null): Buffer {
    const backup = fs.readFileSync(path.join(this.stateDirectory, name));
    if (digest(backup) !== expectedHash) {
      throw new Error(
        `[dev-build] The saved ${name} failed its checksum. The current installation and restore snapshot were left unchanged.`,
      );
    }
    return backup;
  }

  private replacePair(binary: Buffer | null, receipt: Buffer | null): void {
    const oldBinary = this.readOptionalFile(this.executablePath);
    const oldReceipt = this.readOptionalFile(this.receiptPath);
    let binaryChanged = false;
    try {
      this.replaceFile(this.executablePath, binary, true);
      binaryChanged = true;
      this.replaceFile(this.receiptPath, receipt, false);
    } catch (error) {
      if (binaryChanged) {
        try {
          this.replaceFile(this.executablePath, oldBinary, true);
          this.replaceFile(this.receiptPath, oldReceipt, false);
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            '[dev-build] Native installation failed and rollback could not finish. Restore files were retained.',
          );
        }
      }
      throw new Error(
        '[dev-build] Native installation could not be replaced. Close running UAPKG commands and retry; the previous installation was retained.',
        { cause: error },
      );
    }
  }

  private replaceFile(filePath: string, bytes: Buffer | null, executable: boolean): void {
    if (bytes) this.writeAtomic(filePath, bytes, executable);
    else fs.rmSync(filePath, { force: true });
  }

  private writeAtomic(filePath: string, bytes: Buffer, executable = false): void {
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: executable ? 0o755 : 0o600, flush: true });
      fs.renameSync(temporary, filePath);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  private withLock(action: () => void): void {
    fs.mkdirSync(this.binDirectory, { recursive: true });
    const lockPath = path.join(this.binDirectory, '.uapkg-development-link.lock');
    let descriptor: number;
    try {
      descriptor = fs.openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      throw new Error(
        `[dev-build] Another native link operation may be running. If it stopped unexpectedly, remove ${lockPath} before retrying.`,
        { cause: error },
      );
    }
    try {
      fs.writeFileSync(descriptor, `${process.pid}\n`);
      action();
    } finally {
      fs.closeSync(descriptor);
      fs.rmSync(lockPath, { force: true });
    }
  }
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
