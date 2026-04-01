export type ProxyTarget = {
  host: string;
  tcp?: number;
  udp?: number;
  urlProtocol?: 'http' | 'https';
  urlBasePath?: string;
  originalUrl?: string;
};

export type ListenerRule = {
  bind: string;
  tcp?: number;
  udp?: number;
  haproxy?: boolean;
  rewriteBedrockPongPorts?: boolean;
  webhook?: string;
  target: ProxyTarget;
  targets?: ProxyTarget[];
};

export type ProxyConfig = {
  endpoint?: number;
  useRestApi?: boolean;
  savePlayerIP?: boolean;
  listeners: ListenerRule[];
};
