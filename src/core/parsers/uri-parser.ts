import { diagnostic } from "../diagnostics/index.ts";
import type { Diagnostic } from "../diagnostics/index.ts";
import { createProxyNode, normalizeProtocol } from "../model/proxy-node.ts";
import type { NodeMap, NodeSource, ProxyNode } from "../model/proxy-node.ts";
import { decodeBase64, extractUris } from "../subscription-import/text.ts";

export interface UriParseResult {
  node: ProxyNode | null;
  diagnostics: Diagnostic[];
  ignored?: boolean;
}

function decode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function uriDiagnosticContext(source: NodeSource) {
  return { sourceId: source.sourceId, stage: "uri.parse", ...(source.location ? { location: source.location } : {}) };
}

function numberPort(value: string | number | undefined): number | null {
  const port = typeof value === "number" ? value : Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function boolValue(value: string | null | undefined): boolean | undefined {
  if (value === null || value === undefined) return undefined;
  const token = value.toLowerCase();
  if (["true", "1", "yes", "on"].includes(token)) return true;
  if (["false", "0", "no", "off"].includes(token)) return false;
  return undefined;
}

function listValue(value: string | null | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value.split(",").map(item => item.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

function set(target: NodeMap, key: string, value: unknown) {
  if (value === undefined || value === null || value === "") return;
  target[key] = value;
}

function parseJson(value: string | null): unknown {
  if (!value) return undefined;
  try { return JSON.parse(value); } catch { return value; }
}

const URI_QUERY_KEYS = new Set([
  "security", "sni", "serverName", "alpn", "fp", "allowInsecure", "insecure", "pbk", "sid", "key_share",
  "echEnabled", "echConfigList", "echQueryServerName", "certificate", "fragment", "fragment_fallback_delay",
  "record_fragment", "pinSHA256", "certificate_public_key_sha256", "minVersion", "maxVersion", "type", "path",
  "host", "serviceName", "ed", "eh", "xhttpOptions", "flow", "encryption", "packetEncoding", "packet_encoding",
  "ports", "obfs", "obfs-password", "hopInterval", "idle_session_check_interval", "idle_session_timeout",
  "min_idle_session", "max_idle_session", "congestion_control", "udp_relay_mode", "reduce_rtt", "publickey",
  "presharedkey", "address", "mtu", "reserved", "persistent_keepalive_interval", "jc", "jmin", "jmax", "s1",
  "s2", "s3", "s4", "h1", "h2", "h3", "h4", "i1", "i2", "i3", "i4", "i5", "id",
  "header_protection_key", "content_padding_addition", "rekey_after_time", "rekey_timeout", "reject_after_time",
  "keepalive_timeout", "max_handshake_attempts", "random_trailers", "disable_cookies", "profile", "vhttp", "ip",
  "ipv6", "uri", "idle_timeout", "keep_alive_period", "network_list",
]);

function unknownQueryFields(query: URLSearchParams): NodeMap {
  const extensions: NodeMap = {};
  for (const key of new Set([...query.keys()])) {
    if (URI_QUERY_KEYS.has(key)) continue;
    const values = query.getAll(key);
    extensions[key] = values.length > 1 ? values : values[0];
  }
  return extensions;
}

function transportSettings(settings: NodeMap, query: URLSearchParams) {
  const network = query.get("type")?.toLowerCase();
  if (!network) return;
  settings.network = network;
  const path = query.get("path") ?? undefined;
  const host = query.get("host") ?? undefined;
  const serviceName = query.get("serviceName") ?? undefined;
  if (network === "ws") {
    settings["ws-opts"] = {
      path: path || "/",
      ...(host ? { headers: { Host: host } } : {}),
      ...(query.get("ed") ? { "max-early-data": Number(query.get("ed")) } : {}),
      ...(query.get("eh") ? { "early-data-header-name": query.get("eh") } : {}),
    };
  } else if (network === "grpc") {
    settings["grpc-opts"] = serviceName ? { "grpc-service-name": serviceName } : {};
  } else if (network === "http") {
    settings["h2-opts"] = {
      path: path ? [path] : ["/"],
      ...(host ? { host: host.split(",") } : {}),
    };
  } else if (network === "httpupgrade") {
    settings["http-upgrade-opts"] = { path: path || "/", ...(host ? { host } : {}) };
  } else if (network === "xhttp") {
    settings["xhttp-opts"] = parseJson(query.get("xhttpOptions")) ?? {
      ...(path ? { path } : {}),
      ...(host ? { host } : {}),
    };
  }
}

function tlsSettings(settings: NodeMap, query: URLSearchParams) {
  const security = query.get("security")?.toLowerCase();
  if (security === "tls" || security === "reality") settings.tls = true;
  set(settings, "servername", query.get("sni") ?? query.get("serverName") ?? undefined);
  set(settings, "alpn", listValue(query.get("alpn")));
  set(settings, "client-fingerprint", query.get("fp") ?? undefined);
  const insecure = boolValue(query.get("allowInsecure") ?? query.get("insecure"));
  if (insecure !== undefined) settings["skip-cert-verify"] = insecure;
  if (security === "reality") {
    settings["reality-opts"] = {
      ...(query.get("pbk") ? { "public-key": query.get("pbk") } : {}),
      ...(query.get("sid") ? { "short-id": query.get("sid") } : {}),
      ...(query.get("key_share") ? { key_share: query.get("key_share") } : {}),
    };
  }
  for (const [source, target] of [
    ["certificate", "certificate"],
    ["fragment", "fragment"],
    ["fragment_fallback_delay", "fragment_fallback_delay"],
    ["record_fragment", "record_fragment"],
    ["pinSHA256", "fingerprint"],
    ["certificate_public_key_sha256", "certificate_public_key_sha256"],
    ["minVersion", "tls-min-version"],
    ["maxVersion", "tls-max-version"],
  ]) {
    const value = query.get(source);
    if (value !== null) set(settings, target, value);
  }
  const ech: NodeMap = {};
  const echEnabled = boolValue(query.get("echEnabled"));
  if (echEnabled !== undefined) ech.enabled = echEnabled;
  set(ech, "config", query.get("echConfigList") ?? undefined);
  set(ech, "query-server-name", query.get("echQueryServerName") ?? undefined);
  if (Object.keys(ech).length) settings["ech-opts"] = ech;
}

function parsePlugin(value: string | null): { plugin: string; options: NodeMap } | null {
  if (!value) return null;
  const parts = value.split(";").filter(Boolean);
  if (!parts.length) return null;
  const plugin = parts[0] === "obfs-local" ? "obfs" : parts[0];
  const options: NodeMap = {};
  for (const part of parts.slice(1)) {
    const index = part.indexOf("=");
    const key = index >= 0 ? part.slice(0, index) : part;
    const item = index >= 0 ? part.slice(index + 1) : true;
    if (key === "obfs") options.mode = item;
    else if (key === "obfs-host") options.host = item;
    else if (key === "tls") options.tls = true;
    else options[key] = item;
  }
  return { plugin, options };
}

function commonSettings(settings: NodeMap, query: URLSearchParams) {
  tlsSettings(settings, query);
  transportSettings(settings, query);
  set(settings, "flow", query.get("flow") ?? undefined);
  set(settings, "encryption", query.get("encryption") ?? undefined);
  set(settings, "packet-encoding", query.get("packetEncoding") ?? query.get("packet_encoding") ?? undefined);
}

function parseVmess(uri: string, source: NodeSource, ordinal: number): UriParseResult {
  const payloadText = uri.slice("vmess://".length).split("#", 1)[0];
  const jsonText = decodeBase64(payloadText);
  const diagnostics: Diagnostic[] = [];
  if (!jsonText) {
    diagnostics.push(diagnostic(uriDiagnosticContext(source), "invalid_vmess_payload", "error", "VMess payload is not valid Base64."));
    return { node: null, diagnostics };
  }
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(jsonText) as Record<string, unknown>; }
  catch {
    diagnostics.push(diagnostic(uriDiagnosticContext(source), "invalid_vmess_json", "error", "VMess payload is not valid JSON."));
    return { node: null, diagnostics };
  }
  const port = numberPort(payload.port as string | number | undefined);
  const server = String(payload.add ?? "").trim();
  if (!server || port === null) {
    diagnostics.push(diagnostic(uriDiagnosticContext(source), "invalid_endpoint", "error", "VMess endpoint is missing a server or valid port."));
    return { node: null, diagnostics };
  }
  const settings: NodeMap = {
    uuid: String(payload.id ?? ""),
    alterId: Number(payload.aid ?? 0),
    cipher: String(payload.scy ?? "auto"),
    headerType: String(payload.type ?? "none"),
    ...(payload.tls ? { tls: true } : {}),
    ...(payload.sni ? { sni: payload.sni } : {}),
    ...(payload.alpn ? { alpn: payload.alpn } : {}),
    ...(payload.fp ? { "client-fingerprint": payload.fp } : {}),
    ...(payload.allowInsecure !== undefined ? { "skip-cert-verify": payload.allowInsecure } : {}),
    ...(payload.packetEncoding !== undefined ? { "packet-encoding": payload.packetEncoding } : {}),
    ...(payload.xhttpOptions !== undefined ? { "xhttp-opts": payload.xhttpOptions } : {}),
  };
  const transportQuery = new URLSearchParams({ type: String(payload.net ?? "tcp") });
  for (const key of ["path", "serviceName", "ed", "eh"]) {
    if (payload[key] !== undefined) transportQuery.set(key, String(payload[key]));
  }
  if (payload.host !== undefined) transportQuery.set("host", Array.isArray(payload.host) ? payload.host.join(",") : String(payload.host));
  if (payload.xhttpOptions !== undefined) transportQuery.set("xhttpOptions", JSON.stringify(payload.xhttpOptions));
  transportSettings(settings, transportQuery);
  for (const [sourceKey, targetKey] of [
    ["echEnabled", "enabled"], ["echConfigList", "config"], ["echQueryServerName", "query-server-name"],
  ]) {
    if (payload[sourceKey] !== undefined) {
      settings["ech-opts"] = { ...(settings["ech-opts"] as NodeMap ?? {}), [targetKey]: payload[sourceKey] };
    }
  }
  for (const key of ["certificate", "fragment", "fragment_fallback_delay", "record_fragment", "certificate_public_key_sha256", "minVersion", "maxVersion"]) {
    if (payload[key] !== undefined) settings[key] = payload[key];
  }
  if (payload.pinSHA256 !== undefined) settings.fingerprint = payload.pinSHA256;
  const name = String(payload.ps ?? payload.name ?? `${server}:${port}`);
  const knownPayload = new Set([
    "v", "ps", "name", "add", "port", "id", "aid", "scy", "net", "type", "path", "host", "serviceName", "ed", "eh",
    "tls", "sni", "alpn", "fp", "allowInsecure", "packetEncoding", "xhttpOptions", "echEnabled", "echConfigList",
    "echQueryServerName", "certificate", "fragment", "fragment_fallback_delay", "record_fragment",
    "pinSHA256", "certificate_public_key_sha256", "minVersion", "maxVersion",
  ]);
  const extensions = Object.fromEntries(Object.entries(payload).filter(([key]) => !knownPayload.has(key)));
  const node = createProxyNode({ protocol: "vmess", name, server, port, settings, source, raw: payload, extensions, ordinal });
  return { node, diagnostics };
}

function parseShadowsocks(uri: string, source: NodeSource, ordinal: number): UriParseResult {
  const diagnostics: Diagnostic[] = [];
  const body = uri.slice("ss://".length);
  const fragmentIndex = body.indexOf("#");
  const name = fragmentIndex >= 0 ? decode(body.slice(fragmentIndex + 1)) : "";
  const main = fragmentIndex >= 0 ? body.slice(0, fragmentIndex) : body;
  const queryIndex = main.indexOf("?");
  const query = new URLSearchParams(queryIndex >= 0 ? main.slice(queryIndex + 1) : "");
  const endpoint = queryIndex >= 0 ? main.slice(0, queryIndex) : main;
  let credentials = "";
  let host = "";
  let portText = "";
  if (endpoint.includes("@")) {
    const at = endpoint.lastIndexOf("@");
    credentials = endpoint.slice(0, at);
    const authority = endpoint.slice(at + 1);
    const colon = authority.lastIndexOf(":");
    host = colon >= 0 ? authority.slice(0, colon) : authority;
    portText = colon >= 0 ? authority.slice(colon + 1) : "";
  } else {
    const decoded = decodeBase64(endpoint);
    if (!decoded) {
      diagnostics.push(diagnostic(uriDiagnosticContext(source), "invalid_ss_payload", "error", "Shadowsocks payload is not valid Base64."));
      return { node: null, diagnostics };
    }
    const at = decoded.lastIndexOf("@");
    const colon = decoded.lastIndexOf(":");
    if (at < 0 || colon < at) {
      diagnostics.push(diagnostic(uriDiagnosticContext(source), "invalid_ss_endpoint", "error", "Shadowsocks endpoint is invalid."));
      return { node: null, diagnostics };
    }
    credentials = decoded.slice(0, at);
    host = decoded.slice(at + 1, colon);
    portText = decoded.slice(colon + 1);
  }
  if (!credentials.includes(":")) {
    const decoded = decodeBase64(credentials);
    if (decoded) credentials = decoded;
  }
  const separator = credentials.indexOf(":");
  const cipher = separator >= 0 ? decode(credentials.slice(0, separator)) : "";
  const password = separator >= 0 ? decode(credentials.slice(separator + 1)) : "";
  const port = numberPort(portText);
  if (!host || port === null || !cipher || !password) {
    diagnostics.push(diagnostic(uriDiagnosticContext(source), "invalid_ss_fields", "error", "Shadowsocks requires cipher, password, server and port."));
    return { node: null, diagnostics };
  }
  const settings: NodeMap = { cipher, password };
  const plugin = parsePlugin(query.get("plugin"));
  if (plugin) { settings.plugin = plugin.plugin; settings["plugin-opts"] = plugin.options; }
  if (query.get("udp_over_tcp") || query.get("udp-over-tcp")) settings["udp-over-tcp"] = true;
  const node = createProxyNode({ protocol: "ss", name: name || `${host}:${port}`, server: host, port, settings, source, raw: uri, ordinal });
  return { node, diagnostics };
}

function parseStandard(uri: string, source: NodeSource, ordinal: number): UriParseResult {
  const scheme = uri.slice(0, uri.indexOf(":")).toLowerCase();
  const diagnostics: Diagnostic[] = [];
  if (scheme === "http" || scheme === "https") return { node: null, diagnostics, ignored: true };
  let url: URL;
  try { url = new URL(uri); }
  catch {
    diagnostics.push(diagnostic(uriDiagnosticContext(source), "invalid_uri", "error", "Proxy URI is invalid."));
    return { node: null, diagnostics };
  }
  const protocol = normalizeProtocol(scheme);
  if (!protocol) {
    diagnostics.push(diagnostic(uriDiagnosticContext(source), "unsupported_protocol", "warning", `Unsupported proxy protocol: ${scheme}.`, "protocol"));
    return { node: null, diagnostics };
  }
  const server = url.hostname.replace(/^\[|\]$/g, "");
  const defaultPort = scheme.startsWith("socks") ? 1080 : scheme === "wireguard" ? 51820 : 443;
  const port = numberPort(url.port || defaultPort);
  if (!server || port === null) {
    diagnostics.push(diagnostic(uriDiagnosticContext(source), "invalid_endpoint", "error", "Proxy endpoint is missing a server or valid port."));
    return { node: null, diagnostics };
  }
  const settings: NodeMap = {};
  let username = decode(url.username);
  let password = decode(url.password);
  if (!password && ["socks", "socks5", "socks4", "socks4a", "tuic", "naive"].includes(protocol)) {
    const separator = username.indexOf(":");
    if (separator >= 0) {
      password = username.slice(separator + 1);
      username = username.slice(0, separator);
    }
  }
  if (protocol === "vless") settings.uuid = username;
  if (protocol === "trojan" || protocol === "hysteria2" || protocol === "anytls") settings.password = username || password;
  if (protocol === "tuic") { settings.uuid = username; settings.password = password; }
  if (protocol === "naive") { settings.username = username; settings.password = password; }
  if (protocol === "wireguard") settings["private-key"] = username || password;
  if (protocol === "masque") settings["private-key"] = username || password;
  if (protocol === "socks" || protocol === "socks5" || protocol === "socks4" || protocol === "socks4a") {
    if (username) settings.username = username;
    if (password) settings.password = password;
  }
  commonSettings(settings, url.searchParams);
  if (protocol === "hysteria2") {
    set(settings, "ports", url.searchParams.get("ports") ?? undefined);
    set(settings, "obfs", url.searchParams.get("obfs") ?? undefined);
    set(settings, "obfs-password", url.searchParams.get("obfs-password") ?? undefined);
    set(settings, "hop-interval", url.searchParams.get("hopInterval") ?? undefined);
  }
  if (protocol === "anytls") {
    for (const key of ["idle_session_check_interval", "idle_session_timeout", "min_idle_session", "max_idle_session"]) set(settings, key, url.searchParams.get(key) ?? undefined);
  }
  if (protocol === "tuic") {
    set(settings, "congestion_control", url.searchParams.get("congestion_control") ?? undefined);
    set(settings, "udp_relay_mode", url.searchParams.get("udp_relay_mode") ?? undefined);
    if (url.searchParams.get("reduce_rtt")) settings["reduce-rtt"] = true;
  }
  if (protocol === "wireguard") {
    set(settings, "public-key", url.searchParams.get("publickey") ?? undefined);
    set(settings, "pre-shared-key", url.searchParams.get("presharedkey") ?? undefined);
    set(settings, "address", listValue(url.searchParams.get("address")));
    set(settings, "mtu", url.searchParams.get("mtu") ?? undefined);
    set(settings, "reserved", listValue(url.searchParams.get("reserved")));
    set(settings, "ip", url.searchParams.get("ip") ?? undefined);
    for (const key of ["persistent_keepalive_interval", "jc", "jmin", "jmax", "s1", "s2", "s3", "s4", "h1", "h2", "h3", "h4", "i1", "i2", "i3", "i4", "i5", "id", "header_protection_key", "content_padding_addition", "rekey_after_time", "rekey_timeout", "reject_after_time", "keepalive_timeout", "max_handshake_attempts", "random_trailers", "disable_cookies"]) set(settings, key, url.searchParams.get(key) ?? undefined);
  }
  if (protocol === "masque") {
    for (const [sourceKey, target] of [["profile", "profile"], ["vhttp", "vhttp"], ["public_key", "public-key"], ["ip", "ip"], ["ipv6", "ipv6"], ["uri", "uri"], ["mtu", "mtu"], ["idle_timeout", "idle_timeout"], ["keep_alive_period", "keep_alive_period"], ["network_list", "network_list"]]) set(settings, target, url.searchParams.get(sourceKey) ?? undefined);
  }
  const name = decode(url.hash.slice(1)) || `${protocol} ${server}:${port}`;
  const extensions = unknownQueryFields(url.searchParams);
  if (!url.searchParams.has("type")) {
    for (const key of ["path", "host", "serviceName", "ed", "eh", "xhttpOptions"]) {
      const value = url.searchParams.get(key);
      if (value !== null) extensions[key] = value;
    }
  }
  const node = createProxyNode({ protocol, name, server, port, settings, source, raw: uri, extensions, ordinal });
  return { node, diagnostics };
}

export function parseUriNode(uri: string, source: NodeSource, ordinal = 0): UriParseResult {
  const normalized = uri.trim().replace(/\\:\/\//g, "://").replace(/\\@/g, "@");
  const scheme = normalized.slice(0, normalized.indexOf(":")).toLowerCase();
  if (scheme === "vmess") return parseVmess(normalized, source, ordinal);
  if (scheme === "ss") return parseShadowsocks(normalized, source, ordinal);
  return parseStandard(normalized, source, ordinal);
}

export function parseUriContent(content: string, source: NodeSource): UriParseResult[] {
  return extractUris(content).map((uri, index) => parseUriNode(uri, { ...source, location: `uri[${index}]` }, index));
}
