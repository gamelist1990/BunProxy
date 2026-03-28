export type ProxyTarget = {
  host: string;
  tcp?: number;
  udp?: number;
};

export type ListenerRule = {
  bind: string;
  tcp?: number;
  udp?: number;
  haproxy?: boolean;
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
