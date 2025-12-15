/**
 * Discord Embed notification builder
 */
export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  timestamp?: string;
  fields?: Array<{
    name: string;
    value: string;
    inline?: boolean;
  }>;
  footer?: {
    text: string;
    icon_url?: string;
  };
}

export interface DiscordMessage {
  content?: string;
  embeds?: DiscordEmbed[];
}

/**
 * Send Discord webhook with Embed
 */
export async function sendDiscordWebhookEmbed(
  webhookUrl: string,
  embed: DiscordEmbed
): Promise<void> {
  try {
    if (!webhookUrl || webhookUrl.trim() === '') return;

    const message: DiscordMessage = {
      embeds: [embed],
    };

    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
  } catch (err) {
    try {
      console.error('[Webhook] Failed to send webhook', err instanceof Error ? err.message : String(err));
    } catch (_) {}
  }
}

/**
 * Create connection embed (when player name is unknown)
 */
export function createConnectionEmbed(
  ip: string,
  port: number,
  protocol: 'TCP' | 'UDP',
  target: string
): DiscordEmbed {
  return {
    title: `接続確立`,
    description: `新しい接続（${protocol}）`,
    color: 0x3498db,
    timestamp: new Date().toISOString(),
    fields: [
      { name: 'IPアドレス', value: ip, inline: true },
      { name: 'ポート', value: String(port), inline: true },
      { name: 'プロトコル', value: protocol, inline: true },
      { name: 'ターゲット', value: target, inline: true },
    ],
    footer: {
      text: 'BunProxy',
    },
  };
}

/**
 * Create disconnection embed (when player name is unknown)
 */
export function createDisconnectionEmbed(
  ip: string,
  port: number,
  protocol: 'TCP' | 'UDP',
  target: string
): DiscordEmbed {
  return {
    title: `接続終了`,
    description: `接続が切断されました（${protocol}）`,
    color: 0xe74c3c,
    timestamp: new Date().toISOString(),
    fields: [
      { name: 'IPアドレス', value: ip, inline: true },
      { name: 'ポート', value: String(port), inline: true },
      { name: 'プロトコル', value: protocol, inline: true },
      { name: 'ターゲット', value: target, inline: true },
    ],
    footer: {
      text: 'BunProxy',
    },
  };
}

/**
 * Create player join embed
 */
export function createPlayerJoinEmbed(
  username: string,
  ip: string,
  port: number | number[],
  protocol: 'TCP' | 'UDP'
): DiscordEmbed {
  const ports = Array.isArray(port) ? port : [port];
  const portValue = ports.length === 1 ? String(ports[0]) : ports.map(p => String(p)).join(', ');
  
  return {
    title: `${username} が参加しました`,
    description: `プレイヤーが接続しました（${protocol}）`,
    color: 0x00ff00,
    timestamp: new Date().toISOString(),
    fields: [
      { name: 'ユーザー名', value: username, inline: true },
      { name: 'IPアドレス', value: ip, inline: true },
      { name: 'ポート', value: portValue, inline: true },
      { name: 'プロトコル', value: protocol, inline: true },
    ],
    footer: {
      text: 'BunProxy',
    },
  };
}

/**
 * Create player leave embed
 */
export function createPlayerLeaveEmbed(
  username: string,
  ip: string,
  port: number,
  protocol: 'TCP' | 'UDP',
  duration?: string
): DiscordEmbed {
  const fields: Array<{
    name: string;
    value: string;
    inline?: boolean;
  }> = [
    { name: 'ユーザー名', value: username, inline: true },
    { name: 'IPアドレス', value: ip, inline: true },
    { name: 'ポート', value: String(port), inline: true },
    { name: 'プロトコル', value: protocol, inline: true },
  ];

  if (duration) {
    fields.push({ name: 'セッション時間', value: duration, inline: true });
  }

  return {
    title: `${username} が退出しました`,
    description: 'プレイヤーが切断されました',
    color: 0xff0000,
    timestamp: new Date().toISOString(),
    fields,
    footer: {
      text: 'BunProxy',
    },
  };
}

/**
 * Create player login embed when only server login notification is available
 */
export function createPlayerLoginEmbed(
  username: string,
  source?: string
): DiscordEmbed {
  return {
    title: `${username} がログインしました`,
    description: `サーバーからログイン通知を受信しました${source ? `（${source}）` : ''}`,
    color: 0x00ff00,
    timestamp: new Date().toISOString(),
    fields: [
      { name: 'ユーザー名', value: username, inline: true },
      { name: '情報源', value: source || 'Management API', inline: true },
    ],
    footer: {
      text: 'BunProxy',
    },
  };
}

/**
 * Create player logout embed when only server logout notification is available
 */
export function createPlayerLogoutEmbed(
  username: string,
  ip?: string,
  ports?: number[],
  protocol?: 'TCP' | 'UDP',
  source?: string
): DiscordEmbed {
  const fields: Array<{
    name: string;
    value: string;
    inline?: boolean;
  }> = [
    { name: 'ユーザー名', value: username, inline: true },
  ];

  if (ip) {
    fields.push({ name: 'IPアドレス', value: ip, inline: true });
  }
  if (ports && ports.length > 0) {
    const portValue = ports.length === 1 ? String(ports[0]) : ports.map(p => String(p)).join(', ');
    fields.push({ name: 'ポート', value: portValue, inline: true });
  }
  if (protocol) {
    fields.push({ name: 'プロトコル', value: protocol, inline: true });
  }
  if (source) {
    fields.push({ name: '情報源', value: source, inline: true });
  }

  return {
    title: `${username} がログアウトしました`,
    description: `サーバーからログアウト通知を受信しました`,
    color: 0xff0000,
    timestamp: new Date().toISOString(),
    fields,
    footer: {
      text: 'BunProxy',
    },
  };
}
