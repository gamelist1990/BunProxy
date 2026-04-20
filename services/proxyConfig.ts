import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import type { ListenerHttpsConfig, ListenerRule, ProxyConfig, ProxyTarget } from './proxyTypes.js';

export const CONFIG_FILE = path.join(process.cwd(), 'config.yml');

export function writeDefaultConfig(configFile = CONFIG_FILE) {
  const defaultConfig: ProxyConfig = {
    endpoint: 6000,
    useRestApi: false,
    savePlayerIP: true,
    debug: false,
    listeners: [
      {
        bind: '0.0.0.0',
        tcp: 8000,
        udp: 8001,
        haproxy: false,
        https: {
          enabled: false,
          autoDetect: true,
        },
        webhook: '',
        target: { host: '127.0.0.1', tcp: 9000, udp: 9001 },
      },
    ],
  };

  fs.writeFileSync(configFile, YAML.stringify(defaultConfig), { encoding: 'utf-8' });
  console.log('Created default config.yml');
}

function normalizePort(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  let parsed: number;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    parsed = Number(value.trim());
  } else {
    throw new Error(`${fieldName} must be an integer port in range 1-65535`);
  }

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${fieldName} must be an integer port in range 1-65535`);
  }

  return parsed;
}

function parseTargetHost(value: string, fieldName: string) {
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new Error(`${fieldName}.host must be a non-empty string`);
  }

  try {
    const parsed = new URL(trimmed);
    if (!parsed.hostname) {
      throw new Error(`${fieldName}.host URL must include a hostname`);
    }

    const parsedPort = parsed.port === ''
      ? parsed.protocol === 'https:'
        ? 443
        : parsed.protocol === 'http:'
          ? 80
          : undefined
      : normalizePort(parsed.port, `${fieldName}.host`);
    return {
      host: parsed.hostname,
      port: parsedPort,
      protocol: parsed.protocol === 'https:'
        ? 'https'
        : parsed.protocol === 'http:'
          ? 'http'
          : undefined as 'http' | 'https' | undefined,
      basePath: parsed.pathname && parsed.pathname !== '/' ? parsed.pathname.replace(/\/+$/, '') || '/' : undefined,
      originalUrl: trimmed,
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes('must')) {
      throw error;
    }

    return {
      host: trimmed,
      port: undefined,
      protocol: undefined,
      basePath: undefined,
      originalUrl: undefined,
    };
  }
}

function normalizeTarget(target: unknown, fieldName: string): ProxyTarget {
  if (!target || typeof target !== 'object') {
    throw new Error(`${fieldName} must be an object`);
  }

  const candidate = target as Record<string, unknown>;
  if (typeof candidate.host !== 'string' || candidate.host.trim() === '') {
    throw new Error(`${fieldName}.host must be a non-empty string`);
  }

  const normalizedHost = parseTargetHost(candidate.host, fieldName);
  const tcpPort = normalizePort(candidate.tcp, `${fieldName}.tcp`) ?? normalizedHost.port;
  const udpPort = normalizePort(candidate.udp, `${fieldName}.udp`) ?? normalizedHost.port;

  return {
    ...candidate,
    host: normalizedHost.host,
    tcp: tcpPort,
    udp: udpPort,
    urlProtocol: normalizedHost.protocol,
    urlBasePath: normalizedHost.basePath,
    originalUrl: normalizedHost.originalUrl,
  };
}

function normalizeHttpsConfig(value: unknown, fieldName: string): ListenerHttpsConfig | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'object') {
    throw new Error(`${fieldName} must be an object`);
  }

  const candidate = value as Record<string, unknown>;
  const certPath = typeof candidate.certPath === 'string' && candidate.certPath.trim() !== ''
    ? candidate.certPath.trim()
    : undefined;
  const keyPath = typeof candidate.keyPath === 'string' && candidate.keyPath.trim() !== ''
    ? candidate.keyPath.trim()
    : undefined;
  const letsEncryptDomain = typeof candidate.letsEncryptDomain === 'string' && candidate.letsEncryptDomain.trim() !== ''
    ? candidate.letsEncryptDomain.trim()
    : undefined;

  return {
    enabled: typeof candidate.enabled === 'boolean' ? candidate.enabled : false,
    autoDetect: typeof candidate.autoDetect === 'boolean' ? candidate.autoDetect : true,
    letsEncryptDomain,
    certPath,
    keyPath,
  };
}

export function getTargetsForProtocol(rule: ListenerRule, protocol: 'tcp' | 'udp') {
  const baseTargets = Array.isArray(rule.targets) && rule.targets.length > 0
    ? rule.targets
    : rule.target
      ? [rule.target]
      : [];

  return baseTargets.filter((target) => target[protocol] !== undefined);
}

export function loadConfig(configFile = CONFIG_FILE): ProxyConfig {
  if (!fs.existsSync(configFile)) {
    writeDefaultConfig(configFile);
  }

  const text = fs.readFileSync(configFile, { encoding: 'utf-8' });
  const rawConfig = YAML.parse(text) as Record<string, unknown>;

  if (!Array.isArray(rawConfig.listeners)) {
    throw new Error('config.yml must include a listeners array');
  }

  const listeners = rawConfig.listeners.map((rawRule, index) => {
    if (!rawRule || typeof rawRule !== 'object') {
      throw new Error(`listeners[${index}] must be an object`);
    }

    const rule = rawRule as Record<string, unknown>;
    const normalizedTargets = Array.isArray(rule.targets)
      ? rule.targets.map((target, targetIndex) =>
          normalizeTarget(target, `listeners[${index}].targets[${targetIndex}]`))
      : rule.target
        ? [normalizeTarget(rule.target, `listeners[${index}].target`)]
        : [];

    if (normalizedTargets.length === 0) {
      throw new Error(`listeners[${index}] must define target or targets`);
    }

    return {
      ...rule,
      bind: typeof rule.bind === 'string' && rule.bind.trim() !== '' ? rule.bind : '0.0.0.0',
      tcp: normalizePort(rule.tcp, `listeners[${index}].tcp`),
      udp: normalizePort(rule.udp, `listeners[${index}].udp`),
      https: normalizeHttpsConfig(rule.https, `listeners[${index}].https`),
      rewriteBedrockPongPorts: typeof rule.rewriteBedrockPongPorts === 'boolean'
        ? rule.rewriteBedrockPongPorts
        : true,
      target: normalizedTargets[0],
      targets: normalizedTargets,
    } as ListenerRule;
  });

  return {
    endpoint: normalizePort(rawConfig.endpoint, 'endpoint') ?? 6000,
    useRestApi: typeof rawConfig.useRestApi === 'boolean' ? rawConfig.useRestApi : false,
    savePlayerIP: typeof rawConfig.savePlayerIP === 'boolean' ? rawConfig.savePlayerIP : true,
    debug: typeof rawConfig.debug === 'boolean' ? rawConfig.debug : false,
    listeners,
  };
}
