import { decodeBase64, encodeBase64 } from "./text.ts";

export type NodeMap = Record<string, unknown>;
export function map(value: unknown): NodeMap {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as NodeMap : {};
}
export function field(node: NodeMap, ...keys: string[]): unknown {
  for (const key of keys) {
    const actual = Object.keys(node).find(candidate => candidate.toLowerCase() === key.toLowerCase());
    if (actual !== undefined && node[actual] !== null && node[actual] !== undefined) return node[actual];
  }
  return undefined;
}
export function scalar(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value).trim() : "";
}
export function text(node: NodeMap, ...keys: string[]) { return scalar(field(node, ...keys)); }
export function list(value: unknown): string[] {
  return (Array.isArray(value) ? value.map(scalar) : scalar(value).split(",")).filter(Boolean);
}
export function bool(value: unknown): boolean | undefined {
  const token = scalar(value).toLowerCase();
  if (["true", "1", "yes", "on"].includes(token)) return true;
  if (["false", "0", "no", "off"].includes(token)) return false;
  return undefined;
}
function integer(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : /^-?\d+$/.test(scalar(value)) ? Number(value) : undefined;
}
function put(query: Record<string, string>, key: string, value: unknown) {
  const result = scalar(value);
  if (result) query[key] = result;
}
function tlsQuery(proxy: NodeMap) {
  const query: Record<string, string> = {};
  const ech = map(field(proxy, "ech-opts", "ech_opts"));
  const enabled = bool(field(ech, "enable", "enabled"));
  if (enabled !== undefined) query.echEnabled = String(enabled);
  put(query, "echConfigList", field(ech, "config"));
  put(query, "echQueryServerName", field(ech, "query-server-name", "query_server_name"));
  put(query, "certificate", field(proxy, "certificate", "cert"));
  const fragment = bool(field(proxy, "fragment"));
  if (fragment !== undefined) query.fragment = String(fragment);
  put(query, "fragment_fallback_delay", field(proxy, "fragment_fallback_delay", "fragment-fallback-delay"));
  const recordFragment = bool(field(proxy, "record_fragment", "record-fragment"));
  if (recordFragment !== undefined) query.record_fragment = String(recordFragment);
  put(query, "pinSHA256", field(proxy, "fingerprint"));
  put(query, "certificate_public_key_sha256", list(field(proxy, "certificate-public-key-sha256", "certificate_public_key_sha256")).join(","));
  put(query, "minVersion", field(proxy, "tls-min-version", "min-version", "min_version"));
  put(query, "maxVersion", field(proxy, "tls-max-version", "max-version", "max_version"));
  return query;
}
function transport(proxy: NodeMap): Record<string, string> & { type: string } {
  const raw = text(proxy, "network").toLowerCase();
  let type = ["", "tcp", "raw", "none"].includes(raw) ? "tcp" : raw === "h2" ? "http" : raw === "http-upgrade" ? "httpupgrade" : raw;
  const query: Record<string, string> = {};
  let opts: NodeMap = {};
  if (type === "ws") {
    opts = map(field(proxy, "ws-opts", "ws_opts"));
    if (bool(field(opts, "v2ray-http-upgrade", "v2ray_http_upgrade"))) type = "httpupgrade";
    query.path = text(opts, "path") || "/";
    put(query, "host", list(field(map(field(opts, "headers")), "Host")).join(","));
    if (type === "ws") {
      put(query, "ed", integer(field(opts, "max-early-data", "max_early_data")));
      put(query, "eh", field(opts, "early-data-header-name", "early_data_header_name"));
    }
  } else if (type === "grpc") {
    opts = map(field(proxy, "grpc-opts", "grpc_opts"));
    put(query, "serviceName", field(opts, "grpc-service-name", "service-name"));
  } else if (type === "http") {
    opts = map(field(proxy, "h2-opts", "h2_opts", "http-opts", "http_opts"));
    query.path = list(field(opts, "path"))[0] || "/";
    put(query, "host", (list(field(opts, "host")).length ? list(field(opts, "host")) : list(field(map(field(opts, "headers")), "Host"))).join(","));
  } else if (type === "httpupgrade" || type === "xhttp") {
    opts = map(type === "xhttp" ? field(proxy, "xhttp-opts", "xhttp_opts") : field(proxy, "http-upgrade-opts", "http_upgrade_opts"));
    put(query, "path", field(opts, "path") || (type === "httpupgrade" ? "/" : ""));
    const hosts = list(field(opts, "host"));
    if (!hosts.length) hosts.push(...list(field(map(field(opts, "headers")), "Host")));
    put(query, "host", hosts.join(","));
    if (type === "xhttp" && Object.keys(opts).length) query.xhttpOptions = JSON.stringify(opts);
  }
  return { type, ...query };
}
const percent = (value: string) => encodeURIComponent(value).replace(/[!'()]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
function buildUri(scheme: string, server: string, port: number | string, name: string, credential: string, query: Record<string, string>, encoded = false) {
  let host = server.replace(/^\[|\]$/g, "");
  if (/[\s/?#@]/.test(host)) throw new Error("invalid_node_host");
  if (host.includes(":")) host = `[${host}]`;
  else host = new URL(`http://${host}`).hostname;
  const params = Object.entries(query).map(([key, value]) => `${percent(key)}=${percent(value)}`).join("&");
  return `${scheme}://${credential ? (encoded ? credential : percent(credential)) + "@" : ""}${host}:${port}${params ? "?" + params : ""}#${percent(name)}`;
}

/** 对应客户端 NodeUriEncoder；保持原生传输参数，避免按当前内核裁剪配置。 */
export function encodeNode(proxy: NodeMap, globalFingerprint = ""): string | null {
  const rawType = text(proxy, "type").toLowerCase();
  const version = text(proxy, "version").toLowerCase();
  const type = rawType === "shadowsocks" ? "ss"
    : rawType === "socks" && version === "4" ? "socks4"
    : rawType === "socks" && version === "4a" ? "socks4a"
    : rawType === "hysteria" && version === "2" ? "hysteria2"
    : rawType === "naive+https" ? "naive"
    : rawType;
  const server = text(proxy, "server");
  const port = integer(field(proxy, "port"));
  if (!server || port === undefined || port < 1 || port > 65535) return null;
  const name = text(proxy, "name") || `${type} ${server}:${port}`;
  const query = tlsQuery(proxy);
  const sni = text(proxy, "servername", "sni", "server_name");
  const alpn = list(field(proxy, "alpn")).join(",");
  const fingerprint = text(proxy, "client-fingerprint", "client_fingerprint");
  const insecure = bool(field(proxy, "skip-cert-verify", "skip_cert_verify"));
  const credentials = (username: string, password: string) => username ? (password ? `${username}:${password}` : username) : "";
  const addTls = () => {
    put(query, "sni", sni); put(query, "alpn", alpn); put(query, "fp", fingerprint);
    if (insecure === true) query.allowInsecure = "1";
  };
  const finish = (scheme: string, credential = "", actualPort: number | string = port, encoded = false) => buildUri(scheme, server, actualPort, name, credential, query, encoded);
  switch (type) {
    case "socks": case "socks5": case "socks4": case "socks4a":
      return finish(type === "socks" ? "socks5" : type, credentials(text(proxy, "username"), text(proxy, "password")));
    case "ss": {
      const password = text(proxy, "password"), cipher = text(proxy, "cipher");
      if (!password || !cipher) return null;
      const plugin = text(proxy, "plugin");
      if (plugin) {
        const normalized = plugin === "obfs" ? "obfs-local" : plugin;
        const options: string[] = [];
        for (const [key, value] of Object.entries(map(field(proxy, "plugin-opts", "plugin_opts")))) {
          const option = scalar(value);
          if (!option) continue;
          if (normalized === "obfs-local" && key === "mode") options.push(`obfs=${option}`);
          else if (normalized === "obfs-local" && key === "host") options.push(`obfs-host=${option}`);
          else if (key === "tls" && bool(value)) options.push("tls");
          else if (key === "mux" && bool(value)) options.push("mux=8");
          else options.push(`${key}=${option}`);
        }
        query.plugin = [normalized, ...options].join(";");
      }
      if (bool(field(proxy, "udp-over-tcp", "udp_over_tcp"))) query.udp_over_tcp = "1";
      return finish("ss", encodeBase64(`${cipher === "dummy" ? "none" : cipher}:${password}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), port, true);
    }
    case "vmess": {
      const uuid = text(proxy, "uuid"); if (!uuid) return null;
      const { type: network, xhttpOptions, ...options } = transport(proxy);
      const data: NodeMap = { v: "2", ps: name, add: server, port: String(port), id: uuid, aid: integer(field(proxy, "alterId", "alter-id")) || 0, scy: text(proxy, "cipher") || "auto", net: network, type: "none" };
      if (options.path) data.path = options.path;
      if (options.host) { const hosts = options.host.split(","); data.host = hosts.length === 1 ? hosts[0] : hosts; }
      if (options.serviceName) data.serviceName = options.serviceName;
      if (options.ed) data.ed = Number(options.ed);
      if (options.eh) data.eh = options.eh;
      if (xhttpOptions) data.xhttpOptions = JSON.parse(xhttpOptions);
      if (bool(field(proxy, "tls"))) data.tls = "tls";
      if (sni) data.sni = sni;
      if (alpn) data.alpn = alpn.split(",");
      if (fingerprint) data.fp = fingerprint;
      if (insecure) data.allowInsecure = true;
      const packet = text(proxy, "packet-encoding", "packet_encoding"); if (packet) data.packetEncoding = packet;
      return "vmess://" + encodeBase64(JSON.stringify({ ...data, ...query }));
    }
    case "vless": case "trojan": {
      const credential = text(proxy, type === "vless" ? "uuid" : "password"); if (!credential) return null;
      const reality = map(field(proxy, "reality-opts", "reality_opts"));
      query.security = Object.keys(reality).length ? "reality" : bool(field(proxy, "tls")) || type === "trojan" ? "tls" : "none";
      addTls();
      if (query.security === "reality" && !fingerprint) put(query, "fp", globalFingerprint);
      put(query, "flow", field(proxy, "flow"));
      put(query, "encryption", field(proxy, "encryption"));
      put(query, "packetEncoding", field(proxy, "packet-encoding", "packet_encoding") || (type === "vless" ? "xudp" : ""));
      put(query, "pbk", field(reality, "public-key", "public_key")); put(query, "sid", field(reality, "short-id", "short_id"));
      put(query, "key_share", field(reality, "key_share", "key-share", "keyShare"));
      Object.assign(query, transport(proxy));
      return finish(type, credential);
    }
    case "hysteria2": case "hy2": {
      const password = text(proxy, "password", "auth", "auth-str"); if (!password) return null;
      addTls(); put(query, "obfs", field(proxy, "obfs")); put(query, "obfs-password", field(proxy, "obfs-password", "obfs_password"));
      put(query, "hopInterval", field(proxy, "hop-interval", "hop_interval"));
      return finish("hysteria2", password, text(proxy, "ports") || port);
    }
    case "anytls": {
      const password = text(proxy, "password"); if (!password) return null;
      addTls();
      for (const key of ["idle-session-check-interval", "idle-session-timeout", "min-idle-session", "max-idle-session"]) put(query, key.replace(/-/g, "_"), field(proxy, key, key.replace(/-/g, "_")));
      return finish("anytls", password);
    }
    case "tuic": {
      const uuid = text(proxy, "uuid"); if (!uuid) return null;
      const password = text(proxy, "password", "token");
      addTls(); put(query, "congestion_control", field(proxy, "congestion-controller", "congestion_control")); put(query, "udp_relay_mode", field(proxy, "udp-relay-mode", "udp_relay_mode"));
      if (bool(field(proxy, "reduce-rtt", "reduce_rtt"))) query.reduce_rtt = "1";
      return finish("tuic", password ? `${uuid}:${password}` : uuid);
    }
    case "naive":
      if (!text(proxy, "username") || !text(proxy, "password")) return null;
      put(query, "sni", sni); if (insecure) query.allowInsecure = "1";
      return finish("naive+https", credentials(text(proxy, "username"), text(proxy, "password")));
    case "wireguard": case "wg": {
      const privateKey = text(proxy, "private-key", "private_key"), publicKey = text(proxy, "public-key", "public_key");
      if (!privateKey || !publicKey) return null;
      query.publickey = publicKey; put(query, "presharedkey", field(proxy, "pre-shared-key", "preshared-key", "pre_shared_key"));
      const specialIps = new Set(["quic", "dns", "stun", "sip"]);
      const ipValues = list(field(proxy, "ip", "address"));
      const addresses = [
        ...ipValues.filter(value => !specialIps.has(value.toLowerCase())),
        ...list(field(proxy, "ipv6")),
      ];
      put(query, "address", addresses.join(","));
      put(query, "mtu", field(proxy, "mtu")); put(query, "reserved", list(field(proxy, "reserved")).join(","));
      put(query, "persistent_keepalive_interval", field(proxy, "persistent_keepalive_interval", "persistent-keepalive-interval"));
      for (const key of ["jc", "jmin", "jmax", "s1", "s2", "s3", "s4", "h1", "h2", "h3", "h4", "i1", "i2", "i3", "i4", "i5", "id", "header_protection_key", "content_padding_addition", "rekey_after_time", "rekey_timeout", "reject_after_time", "keepalive_timeout", "max_handshake_attempts", "random_trailers", "disable_cookies"]) put(query, key, field(proxy, key));
      const specialIp = ipValues.find(value => specialIps.has(value.toLowerCase()));
      if (specialIp) query.ip = specialIp;
      return finish("wireguard", privateKey);
    }
    case "masque": {
      const profile = text(proxy, "profile") || "cloudflare";
      const privateKey = text(proxy, "private-key", "private_key");
      const publicKey = text(proxy, "public-key", "public_key");
      const ip = text(proxy, "ip"), ipv6 = text(proxy, "ipv6");
      if (profile !== "standard" && (!privateKey || !publicKey)) return null;
      if (!ip && !ipv6) return null;
      query.profile = profile;
      put(query, "vhttp", field(proxy, "vhttp") || "auto");
      put(query, "public_key", publicKey);
      put(query, "ip", ip); put(query, "ipv6", ipv6); put(query, "uri", field(proxy, "uri"));
      put(query, "mtu", field(proxy, "mtu"));
      put(query, "idle_timeout", field(proxy, "idle_timeout", "idle-timeout"));
      put(query, "keep_alive_period", field(proxy, "keep_alive_period", "keep-alive-period"));
      put(query, "network_list", list(field(proxy, "network_list", "network-list")).join(","));
      addTls();
      return finish("masque", privateKey);
    }
    default: return null;
  }
}

export function addParameters(uri: string, parameters: Record<string, string>) {
  if (!Object.keys(parameters).length) return uri;
  if (uri.startsWith("vmess://")) {
    const payload = map(JSON.parse(decodeBase64(uri.slice(8)) || "{}"));
    for (const [key, value] of Object.entries(parameters)) payload[key === "headerType" ? "type" : key === "quicSecurity" ? "host" : key === "key" ? "path" : key] = value;
    return "vmess://" + encodeBase64(JSON.stringify(payload));
  }
  const hash = uri.indexOf("#");
  const head = hash < 0 ? uri : uri.slice(0, hash);
  return head + (head.includes("?") ? "&" : "?") + Object.entries(parameters).map(([key, value]) => `${percent(key)}=${percent(value)}`).join("&") + (hash < 0 ? "" : uri.slice(hash));
}
