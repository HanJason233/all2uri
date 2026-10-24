import { diagnostic } from "../diagnostics/index.ts";
import type { Diagnostic } from "../diagnostics/index.ts";
import { nodeToMap } from "../model/proxy-node.ts";
import type { ProxyNode } from "../model/proxy-node.ts";
import { encodeNode } from "../subscription-import/encode.ts";
import { validateProxyNode } from "../validation/index.ts";

export type ConversionStatus = "complete" | "lossy" | "unsupported" | "invalid";

export interface EncodedProxyNode {
  node: ProxyNode;
  uri: string | null;
  status: ConversionStatus;
  diagnostics: Diagnostic[];
}

const PASSTHROUGH_FIELDS = [
  "ech-opts", "ech_opts", "echEnabled", "echConfigList", "echQueryServerName", "certificate", "cert", "fragment", "fragment_fallback_delay",
  "fragment-fallback-delay", "record_fragment", "record-fragment", "fingerprint",
  "certificate-public-key-sha256", "certificate_public_key_sha256", "tls-min-version", "tls-max-version",
  "min-version", "max-version", "min_version", "max_version",
];
const TLS_FIELDS = [
  "tls", "sni", "servername", "server_name", "alpn", "client-fingerprint", "client_fingerprint",
  "skip-cert-verify", "skip_cert_verify", "allowInsecure", "insecure",
];
const TRANSPORT_FIELDS = [
  "network", "ws-opts", "ws_opts", "grpc-opts", "grpc_opts", "h2-opts", "h2_opts", "http-opts",
  "http_opts", "http-upgrade-opts", "http_upgrade_opts", "xhttp-opts", "xhttp_opts",
];
const TRANSPORT_PROTOCOL_FIELDS = [
  ...TRANSPORT_FIELDS, "flow", "encryption", "packet-encoding", "packet_encoding",
  "reality-opts", "reality_opts",
];
const WIREGUARD_FIELDS = [
  "private-key", "private_key", "public-key", "public_key", "pre-shared-key", "preshared-key",
  "pre_shared_key", "ip", "ipv6", "address", "mtu", "reserved", "persistent_keepalive_interval",
  "persistent-keepalive-interval", "jc", "jmin", "jmax", "s1", "s2", "s3", "s4", "h1", "h2", "h3",
  "h4", "i1", "i2", "i3", "i4", "i5", "id", "header_protection_key", "content_padding_addition",
  "rekey_after_time", "rekey_timeout", "reject_after_time", "keepalive_timeout", "max_handshake_attempts",
  "random_trailers", "disable_cookies",
];
const PROTOCOL_FIELDS: Record<ProxyNode["protocol"], string[]> = {
  socks: ["username", "password"],
  socks4: ["username", "password"],
  socks4a: ["username", "password"],
  socks5: ["username", "password"],
  ss: ["password", "cipher", "method", "plugin", "plugin-opts", "plugin_opts", "udp-over-tcp", "udp_over_tcp"],
  vmess: ["uuid", "alterId", "alter-id", "cipher", "headerType", "header_type", "packet-encoding", "packet_encoding", ...TLS_FIELDS, ...TRANSPORT_FIELDS],
  vless: ["uuid", ...TLS_FIELDS, ...TRANSPORT_PROTOCOL_FIELDS],
  trojan: ["password", ...TLS_FIELDS, ...TRANSPORT_PROTOCOL_FIELDS],
  hysteria2: ["password", "auth", "auth-str", "ports", "obfs", "obfs-password", "obfs_password", "hop-interval", "hop_interval", ...TLS_FIELDS],
  anytls: ["password", "idle-session-check-interval", "idle_session_check_interval", "idle-session-timeout", "idle_session_timeout", "min-idle-session", "min_idle_session", "max-idle-session", "max_idle_session", ...TLS_FIELDS],
  tuic: ["uuid", "password", "congestion-controller", "congestion_control", "udp-relay-mode", "udp_relay_mode", "reduce-rtt", "reduce_rtt", ...TLS_FIELDS],
  naive: ["username", "user", "password", "sni", "servername", "server_name", "skip-cert-verify", "skip_cert_verify", "allowInsecure", "insecure"],
  wireguard: WIREGUARD_FIELDS,
  masque: ["profile", "private-key", "private_key", "public-key", "public_key", "vhttp", "ip", "ipv6", "uri", "mtu", "idle_timeout", "idle-timeout", "keep_alive_period", "keep-alive-period", "network_list", "network-list", ...TLS_FIELDS],
};

const IGNORED_FIELDS = new Set<string>([
  "name", "type", "server", "port", "ps", "remarks", "tag", "raw", "sources", "extensions",
  "routing", "rules", "rule", "direct", "outbound", "inbound",
]);

function unknownFields(node: ProxyNode): string[] {
  const supported = new Set([...PASSTHROUGH_FIELDS, ...PROTOCOL_FIELDS[node.protocol]]);
  const unknown = [
    ...Object.keys(node.settings).filter(field => !supported.has(field) && !IGNORED_FIELDS.has(field)),
    ...Object.keys(node.extensions),
  ];
  const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const addNested = (root: string, value: unknown, allowed: string[]) => {
    for (const key of Object.keys(object(value))) if (!allowed.includes(key)) unknown.push(`${root}.${key}`);
  };
  const settings = node.settings;
  const transport = String(settings.network ?? "").toLowerCase();
  const transportOptions = new Set(transport === "ws" ? ["ws-opts", "ws_opts"]
    : transport === "grpc" ? ["grpc-opts", "grpc_opts"]
      : ["http", "h2"].includes(transport) ? ["h2-opts", "h2_opts", "http-opts", "http_opts"]
        : ["httpupgrade", "http-upgrade"].includes(transport) ? ["http-upgrade-opts", "http_upgrade_opts"]
          : transport === "xhttp" ? ["xhttp-opts", "xhttp_opts"] : []);
  for (const key of TRANSPORT_FIELDS.slice(1)) {
    if (Object.prototype.hasOwnProperty.call(settings, key) && !transportOptions.has(key)) unknown.push(key);
  }
  addNested("ws-opts", settings["ws-opts"] ?? settings.ws_opts, ["path", "headers", "max-early-data", "max_early_data", "early-data-header-name", "early_data_header_name", "v2ray-http-upgrade", "v2ray_http_upgrade"]);
  addNested("grpc-opts", settings["grpc-opts"] ?? settings.grpc_opts, ["grpc-service-name", "service-name", "service_name"]);
  addNested("h2-opts", settings["h2-opts"] ?? settings.h2_opts ?? settings["http-opts"] ?? settings.http_opts, ["path", "host", "headers"]);
  addNested("http-upgrade-opts", settings["http-upgrade-opts"] ?? settings.http_upgrade_opts, ["path", "host", "headers"]);
  addNested("reality-opts", settings["reality-opts"] ?? settings.reality_opts, ["public-key", "public_key", "short-id", "short_id", "key_share", "key-share", "keyShare"]);
  addNested("ech-opts", settings["ech-opts"] ?? settings.ech_opts, ["enable", "enabled", "config", "query-server-name", "query_server_name"]);
  for (const key of ["ws-opts", "ws_opts", "h2-opts", "h2_opts", "http-opts", "http_opts", "http-upgrade-opts", "http_upgrade_opts"]) {
    const headers = object(object(settings[key]).headers);
    for (const header of Object.keys(headers)) {
      if (header.toLowerCase() !== "host") unknown.push(`${key}.headers.${header}`);
    }
  }
  return [...new Set(unknown)];
}

function nodeContext(node: ProxyNode, stage: string) {
  const origin = node.sources[0];
  return {
    sourceId: origin?.sourceId ?? "unknown",
    ...(origin?.location ? { location: origin.location } : {}),
    nodeId: node.id,
    stage,
  };
}

export function encodeProxyNode(node: ProxyNode): EncodedProxyNode {
  // 仅编码目标 URI 明确支持的字段；其余字段保留诊断，并把结果标记为有损。
  const diagnostics = validateProxyNode(node);
  if (diagnostics.some(item => item.severity === "error")) {
    return { node, uri: null, status: "invalid", diagnostics };
  }
  const unknown = unknownFields(node);
  for (const field of unknown) {
    diagnostics.push(diagnostic(
      nodeContext(node, "encode"),
      "field_not_encoded",
      "warning",
      `Field "${field}" is not represented by the client-compatible URI encoder.`,
      field,
    ));
  }
  let uri: string | null = null;
  try {
    const proxy = nodeToMap(node);
    if (node.protocol === "naive") proxy.type = "naive";
    uri = encodeNode(proxy);
  } catch (error) {
    diagnostics.push(diagnostic(
      nodeContext(node, "encode"),
      "encode_exception",
      "error",
      error instanceof Error ? error.message : String(error),
    ));
  }
  if (!uri) {
    diagnostics.push(diagnostic(
      nodeContext(node, "encode"),
      "unsupported_encoding",
      "warning",
      `No URI encoder is available for protocol ${node.protocol}.`,
    ));
    if (diagnostics.some(item => item.severity === "error")) {
      return { node, uri: null, status: "invalid", diagnostics };
    }
    return { node, uri: null, status: "unsupported", diagnostics };
  }
  return { node, uri, status: unknown.length ? "lossy" : "complete", diagnostics };
}

export function encodeProxyNodes(nodes: ProxyNode[]): EncodedProxyNode[] {
  return nodes.map(encodeProxyNode);
}
