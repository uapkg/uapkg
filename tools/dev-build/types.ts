import type { UAPKGBuildMode } from '@uapkg/common';
import type { DevelopmentPathSnapshot } from './DevelopmentPath.ts';

export type DevBuildMode = 'build' | 'link' | 'watch' | 'unlink' | 'status' | 'clean' | 'cleanAll';

export interface DevBuildOptions {
  force: boolean;
  buildMode: UAPKGBuildMode;
}

export interface DevelopmentInstallReceipt {
  schemaVersion: 1;
  installMethod: 'development';
  defaultCliVersion: string;
  development: {
    enginePath: string;
    nodePath: string;
    checkoutPath: string;
  };
}

export interface NativeLinkSnapshot {
  schemaVersion: 2;
  checkoutPath: string;
  binDirectory: string;
  previousBinary: boolean;
  previousReceipt: boolean;
  previousBinaryHash: string | null;
  previousReceiptHash: string | null;
  installedBinaryHash: string;
  installedReceiptHash: string;
  path: DevelopmentPathSnapshot;
}

export interface NativeInstallStatus {
  binDirectory: string;
  executablePath: string;
  receiptPath: string;
  snapshotPath: string;
  installed: boolean;
  owned: boolean;
  receipt: DevelopmentInstallReceipt | null;
}
