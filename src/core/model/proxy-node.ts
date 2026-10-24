export type NodeMap = Record<string, unknown>;

export type ProxyProtocol =
  | "socks"
  | "socks4"
  | "socks4a"
  | "socks5"
  | "ss"
  | "vmess"
  | "vless"
  | "trojan"
  | "hysteria2"
  | "anytls"
  | "tuic"
  | "naive"
  | "wireguard"
  | "masque";

export interface NodeSource {
  sourceId: string;
  sourceName?: string;
  format: string;
  location?: string;
}

/** 统一节点保留协议专属设置、原始节点数据和不能编码的扩展字段。 */
export interface BaseProxyNode<P extends ProxyProtocol, S extends NodeMap> {
  id: string;
  protocol: P;
  name: string;
  server: string;
  port: number;
  settings: S;
  sources: NodeSource[];
  raw: unknown;
  extensions: NodeMap;
}

export interface VlessSettings extends NodeMap { uuid: string; }
export interface VmessSettings extends NodeMap { uuid: string; }
export interface TrojanSettings extends NodeMap { password: string; }
export interface ShadowsocksSettings extends NodeMap { cipher: string; password: string; }
export interface Hysteria2Settings extends NodeMap { password: string; }
export interface AnyTlsSettings extends NodeMap { password: string; }
export interface TuicSettings extends NodeMap { uuid: string; }
export interface NaiveSettings extends NodeMap { username: string; password: string; }
export interface WireGuardSettings extends NodeMap { "private-key": string; "public-key": string; }
export interface MasqueSettings extends NodeMap { profile: string; }

export type ProxyNode =
  | BaseProxyNode<"socks", NodeMap>
  | BaseProxyNode<"socks4", NodeMap>
  | BaseProxyNode<"socks4a", NodeMap>
  | BaseProxyNode<"socks5", NodeMap>
  | BaseProxyNode<"ss", ShadowsocksSettings>
  | BaseProxyNode<"vmess", VmessSettings>
  | BaseProxyNode<"vless", VlessSettings>
  | BaseProxyNode<"trojan", TrojanSettings>
  | BaseProxyNode<"hysteria2", Hysteria2Settings>
  | BaseProxyNode<"anytls", AnyTlsSettings>
  | BaseProxyNode<"tuic", TuicSettings>
  | BaseProxyNode<"naive", NaiveSettings>
  | BaseProxyNode<"wireguard", WireGuardSettings>
  | BaseProxyNode<"masque", MasqueSettings>;

const PROTOCOL_ALIASES: Record<string, ProxyProtocol> = {
  shadowsocks: "ss",
  ss: "ss",
  socks: "socks5",
  socks5: "socks5",
  socks4: "socks4",
  socks4a: "socks4a",
  vmess: "vmess",
  vless: "vless",
  trojan: "trojan",
  hysteria2: "hysteria2",
  hy2: "hysteria2",
  anytls: "anytls",
  tuic: "tuic",
  naive: "naive",
  "naive+https": "naive",
  wireguard: "wireguard",
  wg: "wireguard",
  masque: "masque",
};

export function normalizeProtocol(value: string): ProxyProtocol | null {
  return PROTOCOL_ALIASES[value.trim().toLowerCase()] ?? null;
}

export function isSupportedProtocol(value: string): value is ProxyProtocol {
  return normalizeProtocol(value) !== null;
}

export function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function nodeIdFor(
  source: NodeSource,
  protocol: ProxyProtocol,
  server: string,
  port: number,
  name: string,
  ordinal = 0,
): string {
  return hashString(`${source.sourceId}|${source.format}|${source.location ?? ""}|${protocol}|${server}|${port}|${name}|${ordinal}`);
}

export function createProxyNode(input: {
  protocol: string;
  name: string;
  server: string;
  port: number;
  settings: NodeMap;
  source: NodeSource;
  raw: unknown;
  extensions?: NodeMap;
  ordinal?: number;
}): ProxyNode | null {
  const protocol = normalizeProtocol(input.protocol);
  if (!protocol) return null;
  const name = input.name.trim() || `${protocol} ${input.server}:${input.port}`;
  const node = {
    id: nodeIdFor(input.source, protocol, input.server, input.port, name, input.ordinal ?? 0),
    protocol,
    name,
    server: input.server.trim(),
    port: input.port,
    settings: input.settings,
    sources: [input.source],
    raw: input.raw,
    extensions: input.extensions ?? {},
  } as ProxyNode;
  return node;
}

export function nodeToMap(node: ProxyNode): NodeMap {
  return {
    ...node.extensions,
    ...node.settings,
    type: node.protocol,
    name: node.name,
    server: node.server,
    port: node.port,
  };
}

export function mergeNodeSources(target: ProxyNode, sources: NodeSource[]): ProxyNode {
  const seen = new Set(target.sources.map(source => `${source.sourceId}|${source.format}|${source.location ?? ""}`));
  for (const source of sources) {
    const key = `${source.sourceId}|${source.format}|${source.location ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      target.sources.push(source);
    }
  }
  return target;
}
