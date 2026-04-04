import fs from 'fs';
import path from 'path';
import type { ListenerHttpsConfig } from './proxyTypes.js';

export type ResolvedTlsCredentials = {
  certPath: string;
  keyPath: string;
  cert: Buffer;
  key: Buffer;
  source: 'manual' | 'auto';
};

function canReadFile(filePath: string) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function normalizePath(filePath: string) {
  return path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
}

function getLetsEncryptPaths(domain: string) {
  const liveDir = path.join('/etc/letsencrypt/live', domain);
  return {
    certPath: path.join(liveDir, 'fullchain.pem'),
    keyPath: path.join(liveDir, 'privkey.pem'),
  };
}

export function resolveListenerTlsCredentials(httpsConfig: ListenerHttpsConfig | undefined): ResolvedTlsCredentials | null {
  if (!httpsConfig?.enabled) {
    return null;
  }

  const manualCertPath = httpsConfig.certPath?.trim();
  const manualKeyPath = httpsConfig.keyPath?.trim();
  if (manualCertPath && manualKeyPath) {
    const certPath = normalizePath(manualCertPath);
    const keyPath = normalizePath(manualKeyPath);
    if (!canReadFile(certPath)) {
      throw new Error(`HTTPS cert file not found: ${certPath}`);
    }
    if (!canReadFile(keyPath)) {
      throw new Error(`HTTPS key file not found: ${keyPath}`);
    }

    return {
      certPath,
      keyPath,
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
      source: 'manual',
    };
  }

  if (httpsConfig.autoDetect === false) {
    throw new Error('HTTPS is enabled but certPath/keyPath are not configured and autoDetect is disabled');
  }

  if (process.platform !== 'linux') {
    throw new Error('HTTPS auto-detection is currently supported only on Linux/Ubuntu. Configure certPath/keyPath manually on this platform');
  }

  const domain = httpsConfig.letsEncryptDomain?.trim();
  if (!domain) {
    throw new Error('HTTPS auto-detection requires letsEncryptDomain to be set');
  }

  const candidate = getLetsEncryptPaths(domain);
  if (canReadFile(candidate.certPath) && canReadFile(candidate.keyPath)) {
    return {
      certPath: candidate.certPath,
      keyPath: candidate.keyPath,
      cert: fs.readFileSync(candidate.certPath),
      key: fs.readFileSync(candidate.keyPath),
      source: 'auto',
    };
  }

  throw new Error(`HTTPS certificates could not be auto-detected. Checked: /etc/letsencrypt/live/${domain}/`);
}
