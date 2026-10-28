import type { NodeMap, ProxyNode } from "../model/proxy-node.ts";

type JsonObject = Record<string, unknown>;

export interface SingBoxTestProfile {
  outbound?: JsonObject;
  endpoint?: JsonObject;
}

export interface SingBoxTestProfileResult {
  profile?: SingBoxTestProfile;
  error?: string;
}

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function stringValue(value: JsonObject, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
  }
  return undefined;
}

function numberValue(value: JsonObject, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    if (typeof candidate === "string" && candidate.trim() && Number.isFinite(Number(candidate))) return Number(candidate);
  }
  return undefined;
}

function booleanValue(value: JsonObject, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "boolean") return candidate;
    if (typeof candidate === "string") {
      if (candidate.toLowerCase() === "true" || candidate === "1") return true;
      if (candidate.toLowerCase() === "false" || candidate === "0") return false;
    }
  }
  return undefined;
}

function listValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map(item => item.trim()).filter(Boolean);
  return [];
}

function headersValue(value: unknown): JsonObject | undefined {
  const headers = asObject(value);
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(headers)) {
    if (typeof item === "string" || typeof item === "number") result[key] = String(item);
  }
  return Object.keys(result).length ? result : undefined;
}

function buildTls(settings: NodeMap, force: boolean): JsonObject | undefined {
  const security = stringValue(settings, "security")?.toLowerCase();
  const tlsFlag = settings.tls;
  const enabled = force
    || tlsFlag === true
    || (typeof tlsFlag === "string" && ["tls", "reality"].includes(tlsFlag.toLowerCase()))
    || security === "tls"
    || security === "reality";
  if (!enabled) return undefined;

  const tls: JsonObject = { enabled: true };
  const serverName = stringValue(settings, "sni", "servername", "server_name", "server-name");
  if (serverName) tls.server_name = serverName;
  const insecure = booleanValue(settings, "skip-cert-verify", "skip_cert_verify", "insecure", "allowInsecure");
  if (insecure !== undefined) tls.insecure = insecure;
  const alpn = listValue(settings.alpn);
  if (alpn.length) tls.alpn = alpn;

  const fingerprint = stringValue(settings, "client-fingerprint", "client_fingerprint", "fingerprint");
  if (fingerprint) tls.utls = { enabled: true, fingerprint };

  const reality = asObject(settings["reality-opts"] ?? settings.reality_opts);
  const publicKey = stringValue(reality, "public-key", "public_key", "publicKey");
  if (publicKey) {
    const shortId = stringValue(reality, "short-id", "short_id", "shortId");
    tls.reality = {
      enabled: true,
      public_key: publicKey,
      ...(shortId ? { short_id: shortId } : {}),
    };
  }

  const ech = asObject(settings["ech-opts"] ?? settings.ech_opts);
  const echEnabled = booleanValue(ech, "enabled", "enable");
  if (echEnabled || stringValue(ech, "config")) {
    tls.ech = {
      enabled: echEnabled ?? true,
      ...(stringValue(ech, "config") ? { config: stringValue(ech, "config") } : {}),
      ...(stringValue(ech, "query-server-name", "query_server_name")
        ? { query_server_name: stringValue(ech, "query-server-name", "query_server_name") }
        : {}),
    };
  }
  return tls;
}

function buildTransport(settings: NodeMap): JsonObject | undefined {
  const network = stringValue(settings, "network", "transport")?.toLowerCase();
  if (!network || ["tcp", "raw", "none"].includes(network)) return undefined;

  if (network === "ws") {
    const options = asObject(settings["ws-opts"] ?? settings.ws_opts);
    const headers = headersValue(options.headers);
    return {
      type: "ws",
      path: stringValue(options, "path") ?? "/",
      ...(headers ? { headers } : {}),
      ...(numberValue(options, "max-early-data", "max_early_data") !== undefined
        ? { max_early_data: numberValue(options, "max-early-data", "max_early_data") }
        : {}),
      ...(stringValue(options, "early-data-header-name", "early_data_header_name")
        ? { early_data_header_name: stringValue(options, "early-data-header-name", "early_data_header_name") }
        : {}),
    };
  }
  if (network === "grpc") {
    const options = asObject(settings["grpc-opts"] ?? settings.grpc_opts);
    return {
      type: "grpc",
      ...(stringValue(options, "grpc-service-name", "service-name", "service_name")
        ? { service_name: stringValue(options, "grpc-service-name", "service-name", "service_name") }
        : {}),
    };
  }
  if (network === "http" || network === "h2") {
    const options = asObject(settings["h2-opts"] ?? settings.h2_opts ?? settings["http-opts"] ?? settings.http_opts);
    const host = listValue(options.host);
    return {
      type: "http",
      path: stringValue(options, "path") ?? "/",
      ...(host.length ? { host } : {}),
      ...(headersValue(options.headers) ? { headers: headersValue(options.headers) } : {}),
    };
  }
  if (network === "httpupgrade" || network === "http-upgrade") {
    const options = asObject(settings["http-upgrade-opts"] ?? settings.http_upgrade_opts);
    return {
      type: "httpupgrade",
      path: stringValue(options, "path") ?? "/",
      ...(stringValue(options, "host") ? { host: stringValue(options, "host") } : {}),
      ...(headersValue(options.headers) ? { headers: headersValue(options.headers) } : {}),
    };
  }
  if (network === "quic") return { type: "quic" };
  throw new Error(`sing-box 当前不支持传输类型：${network}`);
}

function requiredString(settings: NodeMap, keys: string[], label: string): string {
  const value = stringValue(settings, ...keys);
  if (!value) throw new Error(`节点缺少 ${label}`);
  return value;
}

function buildWireGuardEndpoint(node: ProxyNode, settings: NodeMap): JsonObject {
  const privateKey = requiredString(settings, ["private-key", "private_key", "privateKey"], "WireGuard 私钥");
  const publicKey = requiredString(settings, ["public-key", "public_key", "publicKey", "peer_public_key"], "WireGuard 公钥");
  const address = listValue(settings.address ?? settings.local_address ?? settings.localAddress);
  const peer: JsonObject = {
    address: node.server,
    port: node.port,
    public_key: publicKey,
    allowed_ips: ["0.0.0.0/0", "::/0"],
  };
  const preSharedKey = stringValue(settings, "pre-shared-key", "pre_shared_key", "preSharedKey");
  if (preSharedKey) peer.pre_shared_key = preSharedKey;
  const reserved = listValue(settings.reserved).map(Number).filter(value => Number.isInteger(value) && value >= 0 && value <= 255);
  if (reserved.length) peer.reserved = reserved;
  return {
    type: "wireguard",
    tag: "proxy",
    private_key: privateKey,
    address: address.length ? address : ["10.0.0.2/32"],
    ...(numberValue(settings, "mtu") ? { mtu: numberValue(settings, "mtu") } : {}),
    ...(numberValue(settings, "workers") ? { workers: numberValue(settings, "workers") } : {}),
    peers: [peer],
  };
}

function buildOutbound(node: ProxyNode, settings: NodeMap): JsonObject {
  const base: JsonObject = {
    server: node.server,
    server_port: node.port,
  };
  const tls = buildTls(settings, false);
  const transport = buildTransport(settings);

  switch (node.protocol) {
    case "socks":
    case "socks5":
    case "socks4":
    case "socks4a": {
      const username = stringValue(settings, "username", "user");
      const password = stringValue(settings, "password");
      return {
        ...base,
        type: "socks",
        tag: "proxy",
        version: node.protocol === "socks4" ? "4" : node.protocol === "socks4a" ? "4a" : "5",
        ...(username ? { username } : {}),
        ...(password ? { password } : {}),
      };
    }
    case "ss": {
      const method = requiredString(settings, ["cipher", "method"], "Shadowsocks 加密方式");
      const password = requiredString(settings, ["password"], "Shadowsocks 密码");
      const plugin = stringValue(settings, "plugin");
      const pluginOptions = stringValue(settings, "plugin-opts", "plugin_opts");
      return {
        ...base,
        type: "shadowsocks",
        tag: "proxy",
        method,
        password,
        ...(plugin ? { plugin } : {}),
        ...(pluginOptions ? { plugin_opts: pluginOptions } : {}),
      };
    }
    case "vless": {
      const uuid = requiredString(settings, ["uuid"], "VLESS UUID");
      const flow = stringValue(settings, "flow");
      const packetEncoding = stringValue(settings, "packet-encoding", "packet_encoding");
      return {
        ...base,
        type: "vless",
        tag: "proxy",
        uuid,
        ...(flow ? { flow } : {}),
        ...(packetEncoding ? { packet_encoding: packetEncoding } : {}),
        ...(tls ? { tls } : {}),
        ...(transport ? { transport } : {}),
      };
    }
    case "vmess": {
      const uuid = requiredString(settings, ["uuid"], "VMess UUID");
      const alterId = numberValue(settings, "alterId", "alter_id") ?? 0;
      const security = stringValue(settings, "cipher", "security") ?? "auto";
      const packetEncoding = stringValue(settings, "packet-encoding", "packet_encoding");
      return {
        ...base,
        type: "vmess",
        tag: "proxy",
        uuid,
        alter_id: alterId,
        security,
        ...(booleanValue(settings, "global_padding", "global-padding") !== undefined
          ? { global_padding: booleanValue(settings, "global_padding", "global-padding") }
          : {}),
        ...(booleanValue(settings, "authenticated_length", "authenticated-length") !== undefined
          ? { authenticated_length: booleanValue(settings, "authenticated_length", "authenticated-length") }
          : {}),
        ...(packetEncoding ? { packet_encoding: packetEncoding } : {}),
        ...(tls ? { tls } : {}),
        ...(transport ? { transport } : {}),
      };
    }
    case "trojan": {
      const password = requiredString(settings, ["password"], "Trojan 密码");
      const forcedTls = buildTls(settings, true);
      return {
        ...base,
        type: "trojan",
        tag: "proxy",
        password,
        ...(forcedTls ? { tls: forcedTls } : {}),
        ...(transport ? { transport } : {}),
      };
    }
    case "hysteria2": {
      const password = stringValue(settings, "password");
      const obfs = stringValue(settings, "obfs");
      const obfsPassword = stringValue(settings, "obfs-password", "obfs_password");
      const forcedTls = buildTls(settings, true);
      return {
        ...base,
        type: "hysteria2",
        tag: "proxy",
        ...(password ? { password } : {}),
        ...(numberValue(settings, "up_mbps", "up-mbps") ? { up_mbps: numberValue(settings, "up_mbps", "up-mbps") } : {}),
        ...(numberValue(settings, "down_mbps", "down-mbps") ? { down_mbps: numberValue(settings, "down_mbps", "down-mbps") } : {}),
        ...(obfs ? { obfs: { type: obfs, ...(obfsPassword ? { password: obfsPassword } : {}) } } : {}),
        ...(forcedTls ? { tls: forcedTls } : {}),
      };
    }
    case "tuic": {
      const uuid = requiredString(settings, ["uuid"], "TUIC UUID");
      const password = requiredString(settings, ["password"], "TUIC 密码");
      const congestion = stringValue(settings, "congestion_control", "congestion-controller");
      const udpRelayMode = stringValue(settings, "udp_relay_mode", "udp-relay-mode");
      const forcedTls = buildTls(settings, true);
      return {
        ...base,
        type: "tuic",
        tag: "proxy",
        uuid,
        password,
        ...(congestion ? { congestion_control: congestion } : {}),
        ...(udpRelayMode ? { udp_relay_mode: udpRelayMode } : {}),
        ...(booleanValue(settings, "reduce_rtt", "reduce-rtt") !== undefined
          ? { reduce_rtt: booleanValue(settings, "reduce_rtt", "reduce-rtt") }
          : {}),
        ...(forcedTls ? { tls: forcedTls } : {}),
      };
    }
    case "anytls": {
      const password = requiredString(settings, ["password"], "AnyTLS 密码");
      const forcedTls = buildTls(settings, true);
      return {
        ...base,
        type: "anytls",
        tag: "proxy",
        password,
        ...(forcedTls ? { tls: forcedTls } : {}),
      };
    }
    case "naive":
      throw new Error("sing-box ??????? Naive");
    case "wireguard":
      throw new Error("wireguard is an endpoint");
    case "masque":
      throw new Error("sing-box 当前不支持 MASQUE 节点测试");
    default:
      throw new Error("sing-box 不支持该协议");
  }
}

/** Builds the minimal sing-box profile used by the desktop node tester. */
export function buildSingBoxTestProfile(node: ProxyNode): SingBoxTestProfileResult {
  const settings: NodeMap = { ...node.extensions, ...node.settings };
  try {
    if (node.protocol === "wireguard") {
      return { profile: { endpoint: buildWireGuardEndpoint(node, settings) } };
    }
    return { profile: { outbound: buildOutbound(node, settings) } };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
