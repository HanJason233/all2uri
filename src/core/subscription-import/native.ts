import { addParameters, bool, encodeNode, list, map, scalar, text, type NodeMap } from "./encode.ts";
import { encodeBase64 } from "./text.ts";

function copy(source: NodeMap, target: NodeMap, pairs: string[]) {
  for (const pair of pairs) {
    const [from, to = from] = pair.split(":");
    if (source[from] !== null && source[from] !== undefined) target[to] = source[from];
  }
}
const objects = (value: unknown) => Array.isArray(value) ? value.map(map) : [];
const lines = (value: unknown) => Array.isArray(value) ? value.map(scalar).join("\n") : scalar(value);
const transportKey = (type: string) => ({ grpc: "grpc-opts", http: "h2-opts", httpupgrade: "http-upgrade-opts" }[type] || type + "-opts");
const name = (node: NodeMap, fallback: string) => text(node, "remarks", "name", "tag") || fallback;

function convert(proxy: NodeMap, native: NodeMap, format: "sing-box" | "xray") {
  const uri = encodeNode(proxy);
  if (!uri) return null;
  const extras: Record<string, string> = {};
  const add = (key: string, value: unknown) => { const result = scalar(value); if (result) extras[key] = result; };
  if (format === "sing-box") {
    for (const key of ["hop_interval", "network", "heartbeat", "zero_rtt_handshake", "udp_over_stream", "udp_over_tcp", "insecure_concurrency", "quic_congestion_control", "quic", "workers", "global_padding", "authenticated_length", "packet_encoding", "path", "persistent_keepalive_interval"]) add(key, native[key]);
    add("host", list(map(native.headers).Host)[0]);
    const transport = map(native.transport);
    add("method", transport.method); add("idleTimeout", transport.idle_timeout); add("pingTimeout", transport.ping_timeout);
  } else {
    const stream = map(native.streamSettings);
    const xhttp = map(stream.xhttpSettings || stream.splithttpSettings);
    add("mode", xhttp.mode);
    if (xhttp.extra !== undefined) extras.extra = JSON.stringify(xhttp.extra);
    const grpc = map(stream.grpcSettings);
    add("authority", grpc.authority); if (bool(grpc.multiMode)) extras.mode = "multi";
    const kcp = map(stream.kcpSettings), quic = map(stream.quicSettings);
    add("seed", kcp.seed); add("headerType", map(kcp.header).type);
    add("quicSecurity", quic.security); add("key", quic.key); add("headerType", map(quic.header).type);
    const header = map(map(stream.tcpSettings || stream.rawSettings).header);
    if (header.type === "http") {
      extras.headerType = "http";
      add("path", list(map(header.request).path)[0]);
      add("host", list(map(map(header.request).headers).Host).join(","));
    }
    add("host", list(map(map(native.settings).headers).Host)[0]);
    const tls = map(stream.tlsSettings || stream.realitySettings);
    add("verifyPeerCertByName", tls.verifyPeerCertByName); add("spx", tls.spiderX);
  }
  return addParameters(uri, extras);
}

function singBox(node: NodeMap): string[] {
  const raw = text(node, "type");
  const type = raw === "shadowsocks" ? "ss" : raw === "socks" ? text(node, "version") === "4" ? "socks4" : text(node, "version") === "4a" ? "socks4a" : "socks5" : raw;
  const proxy: NodeMap = { type, name: name(node, type) };
  copy(node, proxy, ["server", "server_port:port", "uuid", "password", "username", "encryption", "method:cipher", "security:cipher", "alter_id:alterId", "flow", "packet_encoding:packet-encoding", "congestion_control", "udp_relay_mode", "zero_rtt_handshake:reduce-rtt", "mtu", "idle_session_check_interval:idle-session-check-interval", "idle_session_timeout:idle-session-timeout", "min_idle_session:min-idle-session", "profile", "vhttp", "private_key:private-key", "public_key:public-key", "ip", "ipv6", "uri", "idle_timeout:idle-timeout", "keep_alive_period:keep-alive-period", "network_list:network-list", "persistent_keepalive_interval"]);
  if (node.plugin) proxy.plugin = text(node, "plugin") + (text(node, "plugin_opts") ? ";" + text(node, "plugin_opts") : "");
  const tls = map(node.tls);
  proxy.tls = bool(tls.enabled) || false;
  copy(tls, proxy, ["server_name:sni", "insecure:skip-cert-verify", "alpn", "min_version", "max_version", "certificate_public_key_sha256", "fragment", "fragment_fallback_delay", "record_fragment"]);
  if (tls.certificate) proxy.certificate = lines(tls.certificate);
  const utls = map(tls.utls), reality = map(tls.reality), ech = map(tls.ech);
  if (bool(utls.enabled)) proxy["client-fingerprint"] = utls.fingerprint;
  if (bool(reality.enabled)) proxy["reality-opts"] = { "public-key": reality.public_key, "short-id": reality.short_id, "key_share": reality.key_share || reality.keyShare };
  if (tls.ech) proxy["ech-opts"] = { enabled: ech.enabled, config: lines(ech.config) };
  if (node.transport) {
    const transport = map(node.transport), network = text(transport, "type") || "tcp";
    proxy.network = network;
    const opts: NodeMap = {};
    copy(transport, opts, ["path", "host", "headers", "service_name:grpc-service-name", "max_early_data:max-early-data", "early_data_header_name:early-data-header-name"]);
    if (network === "xhttp") for (const [key, value] of Object.entries(transport)) opts[key] = value;
    proxy[transportKey(network)] = opts;
  }
  if (node.obfs) { proxy.obfs = map(node.obfs).type; proxy["obfs-password"] = map(node.obfs).password; }
  if (node.server_ports) proxy.ports = list(node.server_ports).map(port => port.replace(/:/g, "-")).join(",");
  if (type === "wireguard") {
    copy(node, proxy, ["private_key:private-key", "local_address:address", "address"]);
    copy(node, proxy, ["jc", "jmin", "jmax", "s1", "s2", "s3", "s4", "h1", "h2", "h3", "h4", "i1", "i2", "i3", "i4", "i5", "id", "ip", "ib", "header_protection_key", "content_padding_addition", "rekey_after_time", "rekey_timeout", "reject_after_time", "keepalive_timeout", "max_handshake_attempts", "random_trailers", "disable_cookies"]);
    const peers = objects(node.peers).flatMap(peer => {
      const candidate = { ...proxy };
      copy(peer, candidate, ["address:server", "port", "public_key:public-key", "pre_shared_key:pre-shared-key", "reserved"]);
      const uri = convert(candidate, node, "sing-box"); return uri ? [uri] : [];
    });
    if (peers.length) return peers;
    copy(node, proxy, ["peer_public_key:public-key", "pre_shared_key:pre-shared-key", "reserved"]);
  }
  const uri = convert(proxy, node, "sing-box");
  return uri ? [uri] : [];
}

function xrayStream(stream: NodeMap, proxy: NodeMap) {
  const raw = text(stream, "network") || "tcp";
  const network = ({ raw: "tcp", h2: "http", "http-upgrade": "httpupgrade", splithttp: "xhttp" }[raw] || raw);
  proxy.network = network;
  const opts: NodeMap = {};
  copy(map(stream[raw + "Settings"] || stream[network + "Settings"]), opts, ["path", "host", "headers", "serviceName:grpc-service-name", "maxEarlyData:max-early-data", "earlyDataHeaderName:early-data-header-name"]);
  proxy[transportKey(network)] = opts;
  const security = text(stream, "security");
  proxy.tls = security === "tls" || security === "reality";
  const tls = map(security === "reality" ? stream.realitySettings : stream.tlsSettings);
  copy(tls, proxy, ["serverName:sni", "allowInsecure:skip-cert-verify", "alpn", "fingerprint:client-fingerprint", "pinnedPeerCertSha256:fingerprint"]);
  if (security === "reality") proxy["reality-opts"] = { "public-key": tls.password || tls.publicKey, "short-id": tls.shortId, "key_share": tls.keyShare || tls.key_share };
  if (tls.echConfigList) proxy["ech-opts"] = { enabled: true, config: tls.echConfigList };
}

function xray(node: NodeMap): string[] {
  const protocol = text(node, "protocol"), settings = map(node.settings);
  const type = protocol === "shadowsocks" ? "ss" : protocol === "hysteria" ? text(settings, "version") === "2" ? "hysteria2" : "" : protocol;
  if (!type) return [];
  const base: NodeMap = { type, name: name(node, type) };
  const stream = map(node.streamSettings);
  xrayStream(stream, base);
  if (type === "wireguard") {
    copy(settings, base, ["secretKey:private-key", "address", "mtu", "reserved"]);
    return objects(settings.peers).flatMap(peer => {
      try {
        const endpoint = new URL("http://" + text(peer, "endpoint"));
        const proxy = { ...base, server: endpoint.hostname, port: Number(endpoint.port || 80) };
        copy(peer, proxy, ["publicKey:public-key", "preSharedKey:pre-shared-key"]);
        const uri = convert(proxy, node, "xray");
        const extras: Record<string, string> = {};
        if (scalar(peer.keepAlive)) extras.keepalive = scalar(peer.keepAlive);
        if (peer.allowedIPs) extras.allowed_ips = list(peer.allowedIPs).join(",");
        return uri ? [addParameters(uri, extras)] : [];
      } catch { return []; }
    });
  }
  if (type === "hysteria2") {
    copy(settings, base, ["address:server", "port"]);
    base.password = map(stream.hysteriaSettings).auth;
    const mask = map(stream.finalmask);
    base.ports = map(map(mask.quicParams).udpHop).ports;
    const salamander = objects(mask.udp).find(item => item.type === "salamander");
    if (salamander) { base.obfs = "salamander"; base["obfs-password"] = map(salamander.settings).password; }
    const uri = convert(base, node, "xray"); return uri ? [uri] : [];
  }
  let servers = objects(type === "vmess" || type === "vless" ? settings.vnext : settings.servers);
  if (!servers.length && settings.address) servers = [settings];
  return servers.flatMap(server => {
    const users = objects(server.users);
    return (users.length ? users : [server]).flatMap(user => {
      try {
        const proxy = { ...base };
        copy(server, proxy, ["address:server", "port", "password", "method:cipher"]);
        copy(user, proxy, ["id:uuid", "alterId", "security:cipher", "flow", "user:username", "pass:password"]);
        const uri = convert(proxy, node, "xray");
        return uri ? [type === "vless" ? addParameters(uri, { encryption: text(user, "encryption") || "none" }) : uri] : [];
      } catch { return []; }
    });
  });
}

export function extractNativeNodes(
  value: unknown,
  depth = 0,
  visited = new WeakSet<object>(),
  maxNodes = Number.POSITIVE_INFINITY,
): string[] {
  if (depth > 64 || maxNodes <= 0) return [];
  if (value !== null && typeof value === "object") {
    if (visited.has(value)) return [];
    visited.add(value);
  }
  if (Array.isArray(value)) {
    const result: string[] = [];
    for (const item of value) {
      if (result.length >= maxNodes) break;
      result.push(...extractNativeNodes(item, depth + 1, visited, maxNodes - result.length));
    }
    return result;
  }
  const node = map(value);
  if ("outbounds" in node || "endpoints" in node) {
    const result: string[] = [];
    for (const item of [...objects(node.outbounds), ...objects(node.endpoints)]) {
      if (result.length >= maxNodes) break;
      result.push(...extractNativeNodes(item, depth + 1, visited, maxNodes - result.length));
    }
    return result;
  }
  if ("proxies" in node) {
    const result: string[] = [];
    for (const proxy of objects(node.proxies)) {
      if (result.length >= maxNodes) break;
      result.push(...safeEncode(proxy, text(node, "global-client-fingerprint")).slice(0, maxNodes - result.length));
    }
    return result;
  }
  if ("type" in node && "server" in node && "port" in node && !("server_port" in node)) return safeEncode(node).slice(0, maxNodes);
  if ("add" in node && "id" in node) {
    const payload: NodeMap = {};
    copy(node, payload, ["v", "ps", "add", "port", "id", "aid", "scy", "net", "type", "host", "path", "tls", "sni", "alpn", "fp", "serviceName", "ed", "eh", "seed", "mode", "extra", "global_padding", "authenticated_length", "packetEncoding", "certificate", "certificate_public_key_sha256", "pinSHA256", "verifyPeerCertByName", "echEnabled", "echConfigList", "echQueryServerName"]);
    return ["vmess://" + encodeBase64(JSON.stringify(payload))].slice(0, maxNodes);
  }
  try { return ("protocol" in node ? xray(node) : "type" in node ? singBox(node) : []).slice(0, maxNodes); }
  catch { return []; }
}

export function safeEncode(proxy: NodeMap, fingerprint = ""): string[] {
  try { const uri = encodeNode(proxy, fingerprint); return uri ? [uri] : []; }
  catch { return []; }
}
