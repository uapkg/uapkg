import fs from 'node:fs';
import path from 'node:path';
import {
  createCyclicSymlinkDiagnostic,
  createInvalidPathDiagnostic,
  createSymlinkOutsideRootDiagnostic,
  DiagnosticBag,
  ok,
  type Result,
} from '@uapkg/diagnostics';
import type { CollectedFile } from '#pack/contracts/PackTypes.ts';

export class FileCrawler {
  collect(pluginRoot: string, excluded: (relativePath: string) => boolean = () => false): Result<CollectedFile[]> {
    const files: CollectedFile[] = [];
    const pluginRootReal = fs.realpathSync(pluginRoot);
    const bag = new DiagnosticBag();
    this.walk(pluginRoot, pluginRootReal, pluginRoot, files, new Set(), bag, excluded);
    if (bag.hasErrors()) return bag.toFailure();
    return ok(files);
  }

  private walk(
    absolutePath: string,
    pluginRootReal: string,
    pluginRoot: string,
    files: CollectedFile[],
    resolutionStack: Set<string>,
    bag: DiagnosticBag,
    excluded: (relativePath: string) => boolean,
  ) {
    if (excluded(path.relative(pluginRoot, absolutePath).split(path.sep).join('/'))) return;
    const stat = fs.lstatSync(absolutePath);

    if (stat.isSymbolicLink()) {
      const targetReal = fs.realpathSync(absolutePath);
      if (excluded(path.relative(pluginRootReal, targetReal).split(path.sep).join('/'))) return;
      if (!this.isPathInRoot(targetReal, pluginRootReal)) {
        bag.add(createSymlinkOutsideRootDiagnostic(absolutePath));
        return;
      }

      if (resolutionStack.has(targetReal)) {
        bag.add(createCyclicSymlinkDiagnostic(absolutePath));
        return;
      }

      const nextStack = new Set(resolutionStack);
      nextStack.add(targetReal);
      this.walkResolved(absolutePath, targetReal, pluginRootReal, pluginRoot, files, nextStack, bag, excluded);
      return;
    }

    this.walkResolved(absolutePath, absolutePath, pluginRootReal, pluginRoot, files, resolutionStack, bag, excluded);
  }

  private walkResolved(
    visiblePath: string,
    resolvedPath: string,
    pluginRootReal: string,
    pluginRoot: string,
    files: CollectedFile[],
    resolutionStack: Set<string>,
    bag: DiagnosticBag,
    excluded: (relativePath: string) => boolean,
  ) {
    const stat = fs.statSync(resolvedPath);

    if (stat.isDirectory()) {
      const entries = fs.readdirSync(resolvedPath).sort();
      for (const entry of entries) {
        const childVisible = path.join(visiblePath, entry);
        this.walk(childVisible, pluginRootReal, pluginRoot, files, resolutionStack, bag, excluded);
      }
      return;
    }

    if (!stat.isFile()) {
      return;
    }

    const relativePath = this.normalizeRelative(pluginRoot, visiblePath, bag);
    if (!relativePath) {
      return;
    }

    files.push({
      absolutePath: resolvedPath,
      relativePath,
    });
  }

  private normalizeRelative(root: string, filePath: string, bag: DiagnosticBag) {
    const relative = path.relative(root, filePath);
    if (!relative || relative.startsWith('..')) {
      return null;
    }

    const normalized = relative.split(path.sep).join('/');
    if (normalized.includes('/./') || normalized.includes('../') || normalized.startsWith('./')) {
      bag.add(createInvalidPathDiagnostic(normalized));
      return null;
    }

    return normalized;
  }

  private isPathInRoot(targetReal: string, pluginRootReal: string): boolean {
    const relative = path.relative(pluginRootReal, targetReal);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  }
}
