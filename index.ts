import path from 'path';
import chalk from 'chalk';
import Table from 'cli-table3';
import boxen from 'boxen';
import { TimestampPlayerMapper } from './services/timestampPlayerMapper.js';
import { ConnectionBuffer } from './services/connectionBuffer.js';
import { PlayerIPMapper } from './services/playerIPMapper.js';
import { startManagementAPI } from './services/managementAPI.js';
import { WebhookGroupNotifier } from './services/groupedWebhookQueue.js';
import { getTargetsForProtocol, loadConfig } from './services/proxyConfig.js';
import type { ProxyRuntime, ConnectionStats } from './services/proxyRuntime.js';
import { startTcpProxy } from './services/tcpProxyServer.js';
import { startUdpProxy } from './services/udpProxyServer.js';

const playerMapper = new TimestampPlayerMapper();
const connectionBuffer = new ConnectionBuffer();
const groupedNotifier = new WebhookGroupNotifier();
const connectionStats: ConnectionStats = {
  tcp: { total: 0, active: 0 },
  udp: { total: 0, active: 0 },
};

async function main() {
  try {
    console.clear();
    console.log(boxen(chalk.bold.cyan('BunProxy Server'), {
      padding: 1,
      margin: 1,
      borderStyle: 'double',
      borderColor: 'cyan',
    }));

    const cfg = loadConfig();
    const endpointPort = cfg.endpoint || 6000;
    const useRestApi = cfg.useRestApi ?? false;
    const savePlayerIP = cfg.savePlayerIP ?? true;
    const playerIPFilePath = path.join(process.cwd(), 'playerIP.json');
    const playerIPMapper = new PlayerIPMapper(playerIPFilePath, savePlayerIP);

    const configTable = new Table({
      head: [chalk.bold.white('Configuration'), chalk.bold.white('Value')],
      colWidths: [25, 30],
      style: { head: [], border: ['cyan'] },
    });

    configTable.push(
      ['REST API Mode', useRestApi ? chalk.green('✓ ENABLED') : chalk.yellow('✗ DISABLED')],
      ['Endpoint Port', chalk.cyan(endpointPort.toString())],
      ['Save Player IP', savePlayerIP ? chalk.green('✓ YES') : chalk.yellow('✗ NO')],
      ['Total Listeners', chalk.cyan(cfg.listeners.length.toString())],
    );

    console.log(configTable.toString());
    console.log('');

    if (useRestApi) {
      const webhooks = cfg.listeners
        .map((rule) => rule.webhook)
        .filter((hook): hook is string => Boolean(hook && hook.trim() !== ''));

      startManagementAPI(endpointPort, playerMapper, connectionBuffer, playerIPMapper, useRestApi, webhooks);
      console.log(chalk.green(`✓ Management API started on port ${endpointPort}`));
    }

    setInterval(() => {
      playerMapper.cleanup();
    }, 60_000);

    const runtime: ProxyRuntime = {
      useRestApi,
      connectionBuffer,
      groupedNotifier,
      connectionStats,
    };

    const listenerTable = new Table({
      head: [
        chalk.bold.white('Protocol'),
        chalk.bold.white('Listening'),
        chalk.bold.white('Forwarding To'),
        chalk.bold.white('HAProxy'),
      ],
      colWidths: [10, 22, 28, 10],
      style: { head: [], border: ['green'] },
    });

    for (const rule of cfg.listeners) {
      const tcpTargets = getTargetsForProtocol(rule, 'tcp');
      const udpTargets = getTargetsForProtocol(rule, 'udp');

      if (rule.tcp !== undefined && tcpTargets.length > 0) {
        startTcpProxy(rule, runtime);
        listenerTable.push([
          rule.https?.enabled ? chalk.green('HTTPS') : chalk.blue('TCP'),
          chalk.cyan(`${rule.bind}:${rule.tcp}`),
          chalk.yellow(tcpTargets.map((target) => `${target.host}:${target.tcp}`).join(' -> ')),
          rule.haproxy ? chalk.green('✓') : chalk.gray('✗'),
        ]);
      }

      if (rule.udp !== undefined && udpTargets.length > 0) {
        startUdpProxy(rule, runtime);
        listenerTable.push([
          chalk.magenta('UDP'),
          chalk.cyan(`${rule.bind}:${rule.udp}`),
          chalk.yellow(udpTargets.map((target) => `${target.host}:${target.udp}`).join(' -> ')),
          rule.haproxy ? chalk.green('✓') : chalk.gray('✗'),
        ]);
      }
    }

    console.log(chalk.bold.green('\n✓ All listeners started:\n'));
    console.log(listenerTable.toString());
    console.log('');
    console.log(boxen(chalk.bold.green('✓ Server is running'), {
      padding: 0,
      margin: { top: 0, bottom: 1, left: 0, right: 0 },
      borderStyle: 'round',
      borderColor: 'green',
      textAlignment: 'center',
    }));
  } catch (err) {
    console.error(chalk.bold.red('✗ Failed to start proxy:'), chalk.red((err as Error).message));
    process.exit(1);
  }
}

main();
