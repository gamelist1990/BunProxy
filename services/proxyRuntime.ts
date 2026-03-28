import type { ConnectionBuffer } from './connectionBuffer.js';
import type { WebhookGroupNotifier } from './groupedWebhookQueue.js';

export type ProxyProtocol = 'TCP' | 'UDP';

export type ConnectionStats = {
  tcp: {
    total: number;
    active: number;
  };
  udp: {
    total: number;
    active: number;
  };
};

export type ProxyRuntime = {
  useRestApi: boolean;
  connectionBuffer: ConnectionBuffer;
  groupedNotifier: WebhookGroupNotifier;
  connectionStats: ConnectionStats;
};
