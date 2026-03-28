import {
  createGroupedConnectionEmbed,
  createGroupedDisconnectionEmbed,
  sendDiscordWebhookEmbed,
} from './discordEmbed.js';
import type { ProxyProtocol } from './proxyRuntime.js';

const GROUP_WINDOW_MS = 3000;

function makeGroupKey(webhook: string, protocol: ProxyProtocol, targetKey: string) {
  return `${webhook}::${protocol}::${targetKey}`;
}

export class WebhookGroupNotifier {
  private readonly groupedClients = new Map<string, Map<string, Set<number>>>();
  private readonly groupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly groupedDisconnects = new Map<string, Map<string, Set<number>>>();
  private readonly disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

  addConnectGroup(webhook: string, targetKey: string, ip: string, port: number, protocol: ProxyProtocol) {
    const groupKey = makeGroupKey(webhook, protocol, targetKey);
    let map = this.groupedClients.get(groupKey);
    if (!map) {
      map = new Map<string, Set<number>>();
      this.groupedClients.set(groupKey, map);
    }

    if (!map.has(ip)) {
      map.set(ip, new Set<number>());
    }
    map.get(ip)!.add(port);

    if (!this.groupTimers.has(groupKey)) {
      this.groupTimers.set(groupKey, setTimeout(() => this.flushGroup(groupKey), GROUP_WINDOW_MS));
    }
  }

  addDisconnectGroup(webhook: string, targetKey: string, ip: string, port: number, protocol: ProxyProtocol) {
    const groupKey = makeGroupKey(webhook, protocol, targetKey);
    let map = this.groupedDisconnects.get(groupKey);
    if (!map) {
      map = new Map<string, Set<number>>();
      this.groupedDisconnects.set(groupKey, map);
    }

    if (!map.has(ip)) {
      map.set(ip, new Set<number>());
    }
    map.get(ip)!.add(port);

    if (!this.disconnectTimers.has(groupKey)) {
      this.disconnectTimers.set(groupKey, setTimeout(() => this.flushDisconnectGroup(groupKey), GROUP_WINDOW_MS));
    }
  }

  private flushGroup(groupKey: string) {
    const parts = groupKey.split('::');
    const webhook = parts[0];
    const protocol = parts[1] as ProxyProtocol;
    const target = parts.slice(2).join('::');
    const map = this.groupedClients.get(groupKey);

    if (!map) {
      return;
    }

    const groups = Array.from(map.entries()).map(([ip, portsSet]) => ({
      ip,
      ports: Array.from(portsSet).sort((a, b) => a - b),
    }));

    void sendDiscordWebhookEmbed(webhook, createGroupedConnectionEmbed(target, protocol, groups));

    this.groupedClients.delete(groupKey);
    const timer = this.groupTimers.get(groupKey);
    if (timer) {
      clearTimeout(timer);
    }
    this.groupTimers.delete(groupKey);
  }

  private flushDisconnectGroup(groupKey: string) {
    const parts = groupKey.split('::');
    const webhook = parts[0];
    const protocol = parts[1] as ProxyProtocol;
    const target = parts.slice(2).join('::');
    const map = this.groupedDisconnects.get(groupKey);

    if (!map) {
      return;
    }

    const groups = Array.from(map.entries()).map(([ip, portsSet]) => ({
      ip,
      ports: Array.from(portsSet).sort((a, b) => a - b),
    }));

    void sendDiscordWebhookEmbed(webhook, createGroupedDisconnectionEmbed(target, protocol, groups));

    this.groupedDisconnects.delete(groupKey);
    const timer = this.disconnectTimers.get(groupKey);
    if (timer) {
      clearTimeout(timer);
    }
    this.disconnectTimers.delete(groupKey);
  }
}
