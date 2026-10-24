import { diagnostic } from "../diagnostics/index.ts";
import type { Diagnostic } from "../diagnostics/index.ts";
import { createProxyNode, normalizeProtocol } from "../model/proxy-node.ts";
import type { NodeMap, NodeSource, ProxyNode } from "../model/proxy-node.ts";

type RecordValue = Record<string, unknown>;

interface NativeCandidate {
  value: RecordValue;
  location: string;
}

interface NativeParseResult {
  nodes: ProxyNode[];
  diagnostics: Diagnostic[];
  truncated: boolean;
}

const MAX_NATIVE_CANDIDATES = 100_000;

function object(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function objects(value: unknown): RecordValue[] {
  return Array.isArray(value) ? value.map(object) : [];
}

function scalar(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value).trim() : "";
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function boolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  const text = scalar(value).toLowerCase();
  if (["true", "1", "yes", "on"].includes(text)) return true;
  if (["false", "0", "no", "off"].includes(text)) return false;
  return undefined;
}

function set(target: NodeMap, key: string, value: unknown): void {
  if (value !== undefined && value !== null && value !== "") target[key] = value;
}

function move(source: RecordValue, target: NodeMap, from: string, to = from): void {
  if (source[from] !== undefined && source[from] !== null) target[to] = source[from];
}

function moveAlias(settings: NodeMap, from: string, to: string): void {
  if (settings[from] !== undefined && settings[to] === undefined) settings[to] = settings[from];
  delete settings[from];
}

function context(source: NodeSource, location: string, stage: string) {
  return { sourceId: source.sourceId, location, stage };
}

function addUnknownExtensions(
  value: RecordValue,
  known: Set<string>,
  extensions: NodeMap,
  prefix: string,
): void {
  for (const [key, child] of Object.entries(value)) {
    if (!known.has(key)) extensions[`${prefix}.${key}`] = child;
  }
}

function mapTls(settings: NodeMap, extensions: NodeMap, rawTls: unknown): void {
  const tls = object(rawTls);
  if (!Object.keys(tls).length) return;
  set(settings, "tls", boolean(tls.enabled));
  move(tls, settings, "server_name", "servername");
  move(tls, settings, "alpn");
  move(tls, settings, "insecure", "skip-cert-verify");
  for (const key of [
    "certificate", "certificate_public_key_sha256", "fragment", "fragment_fallback_delay", "record_fragment",
    "min_version", "max_version",
  ]) move(tls, settings, key, key === "min_version" ? "tls-min-version" : key === "max_version" ? "tls-max-version" : key);

  const utls = object(tls.utls);
  if (boolean(utls.enabled) === true) move(utls, settings, "fingerprint", "client-fingerprint");
  addUnknownExtensions(utls, new Set(["enabled", "fingerprint"]), extensions, "tls.utls");

  const reality = object(tls.reality);
  if (boolean(reality.enabled) === true || Object.keys(reality).length > 0) {
    settings["reality-opts"] = {
      ...(reality.public_key !== undefined ? { "public-key": reality.public_key } : {}),
      ...(reality.short_id !== undefined ? { "short-id": reality.short_id } : {}),
      ...(reality.key_share !== undefined ? { key_share: reality.key_share } : reality.keyShare !== undefined ? { key_share: reality.keyShare } : {}),
    };
  }
  addUnknownExtensions(reality, new Set(["enabled", "public_key", "short_id", "key_share", "keyShare"]), extensions, "tls.reality");

  const ech = object(tls.ech);
  if (Object.keys(ech).length) {
    settings["ech-opts"] = {
      ...(ech.enabled !== undefined ? { enabled: ech.enabled } : {}),
      ...(ech.config !== undefined ? { config: ech.config } : {}),
      ...(ech.query_server_name !== undefined ? { "query-server-name": ech.query_server_name } : {}),
    };
  }
  addUnknownExtensions(ech, new Set(["enabled", "config", "query_server_name"]), extensions, "tls.ech");

  const known = new Set([
    "enabled", "server_name", "alpn", "insecure", "certificate", "certificate_public_key_sha256", "fragment",
    "fragment_fallback_delay", "record_fragment", "min_version", "max_version", "utls", "reality", "ech",
  ]);
  addUnknownExtensions(tls, known, extensions, "tls");
}

function networkName(raw: string): string {
  return ({ raw: "tcp", none: "tcp", h2: "http", "http-upgrade": "httpupgrade", splithttp: "xhttp" } as Record<string, string>)[raw.toLowerCase()] ?? raw.toLowerCase();
}

function transportKey(network: string): string | null {
  return ({
    ws: "ws-opts",
    grpc: "grpc-opts",
    http: "h2-opts",
    httpupgrade: "http-upgrade-opts",
    xhttp: "xhttp-opts",
  } as Record<string, string>)[network] ?? null;
}

function mapTransport(settings: NodeMap, extensions: NodeMap, rawType: string, rawOptions: unknown): void {
  const network = networkName(rawType || "tcp");
  settings.network = network;
  if (network === "tcp") {
    return;
  }
  const key = transportKey(network);
  if (!key) {
    extensions[`transport.${rawType}`] = rawOptions;
    return;
  }
  const options = object(rawOptions);
  const mapped: NodeMap = {};
  move(options, mapped, "path");
  move(options, mapped, "host");
  move(options, mapped, "headers");
  if (network === "grpc") {
    move(options, mapped, "service_name", "grpc-service-name");
    move(options, mapped, "serviceName", "grpc-service-name");
  }
  if (network === "ws") {
    move(options, mapped, "max_early_data", "max-early-data");
    move(options, mapped, "maxEarlyData", "max-early-data");
    move(options, mapped, "early_data_header_name", "early-data-header-name");
    move(options, mapped, "earlyDataHeaderName", "early-data-header-name");
  }
  if (network === "xhttp") {
    Object.assign(mapped, options);
  } else {
    const consumed = new Set(["path", "host", "headers"]);
    if (network === "grpc") { consumed.add("service_name"); consumed.add("serviceName"); }
    if (network === "ws") {
      consumed.add("max_early_data"); consumed.add("maxEarlyData");
      consumed.add("early_data_header_name"); consumed.add("earlyDataHeaderName");
    }
    addUnknownExtensions(options, consumed, extensions, `transport.${network}`);
  }
  settings[key] = mapped;
}

function makeNode(
  protocolName: string,
  name: string,
  server: string,
  portValue: unknown,
  settings: NodeMap,
  extensions: NodeMap,
  raw: unknown,
  source: NodeSource,
  ordinal: number,
  diagnostics: Diagnostic[],
): ProxyNode | null {
  const protocol = normalizeProtocol(protocolName);
  if (!protocol) {
    diagnostics.push(diagnostic(context(source, source.location ?? "", "native.parse"), "unsupported_protocol", "warning", `Unsupported native protocol: ${protocolName || "(empty)"}.`, "type/protocol"));
    return null;
  }
  const port = Number(portValue);
  if (!server || !Number.isInteger(port) || port < 1 || port > 65535) {
    diagnostics.push(diagnostic(context(source, source.location ?? "", "native.parse"), "invalid_endpoint", "error", "Native proxy entry is missing a server or valid port.", "server/port"));
    return null;
  }
  return createProxyNode({
    protocol,
    name: name || `${protocol} ${server}:${port}`,
    server,
    port,
    settings,
    source,
    raw,
    extensions,
    ordinal,
  });
}

function normalizeSingBox(
  raw: RecordValue,
  source: NodeSource,
  ordinal: number,
  maxNodes: number,
  diagnostics: Diagnostic[],
): ProxyNode[] {
  // 先保留原生设置，再映射通用字段；未识别字段由扩展映射记录并参与损失判断。
  const rawType = scalar(raw.type).toLowerCase();
  const version = scalar(raw.version).toLowerCase();
  const protocolName = rawType === "socks" && version === "4" ? "socks4"
    : rawType === "socks" && version === "4a" ? "socks4a"
      : rawType === "hysteria" && version === "2" ? "hysteria2" : rawType;
  const protocol = normalizeProtocol(protocolName);
  const name = scalar(raw.name ?? raw.tag);
  const settings: NodeMap = { ...raw };
  const extensions: NodeMap = {};
  for (const key of ["type", "version", "name", "tag", "server", "server_port", "port", "tls", "transport", "peers", "obfs", "server_ports"]) delete settings[key];
  if (raw.method !== undefined && protocol === "ss") settings.cipher = settings.cipher ?? raw.method;
  moveAlias(settings, "private_key", "private-key");
  moveAlias(settings, "public_key", "public-key");
  moveAlias(settings, "pre_shared_key", "pre-shared-key");
  moveAlias(settings, "local_address", "address");
  moveAlias(settings, "alter_id", "alterId");
  moveAlias(settings, "packet_encoding", "packet-encoding");
  moveAlias(settings, "idle_session_check_interval", "idle-session-check-interval");
  moveAlias(settings, "idle_session_timeout", "idle-session-timeout");
  moveAlias(settings, "min_idle_session", "min-idle-session");
  moveAlias(settings, "max_idle_session", "max-idle-session");
  moveAlias(settings, "zero_rtt_handshake", "reduce-rtt");
  moveAlias(settings, "network_list", "network-list");
  moveAlias(settings, "idle_timeout", "idle-timeout");
  moveAlias(settings, "keep_alive_period", "keep-alive-period");
  if (protocol === "masque" && settings.profile === undefined) settings.profile = "cloudflare";

  mapTls(settings, extensions, raw.tls);
  const transport = object(raw.transport);
  if (Object.keys(transport).length) {
    mapTransport(settings, extensions, scalar(transport.type), transport);
    if (networkName(scalar(transport.type) || "tcp") === "tcp") {
      addUnknownExtensions(transport, new Set(["type"]), extensions, "transport.tcp");
    }
  }
  const obfs = object(raw.obfs);
  if (Object.keys(obfs).length) {
    set(settings, "obfs", obfs.type);
    set(settings, "obfs-password", obfs.password);
    addUnknownExtensions(obfs, new Set(["type", "password"]), extensions, "obfs");
  }
  if (raw.server_ports !== undefined) {
    settings.ports = list(raw.server_ports).map(value => scalar(value).replace(/:/g, "-")).filter(Boolean).join(",");
  }
  if (protocol === "hysteria2" && raw.auth !== undefined && settings.password === undefined) settings.password = raw.auth;

  const baseServer = scalar(raw.server ?? (protocol === "wireguard" ? "" : raw.address));
  const basePort = raw.server_port ?? raw.port;
  const peers = protocol === "wireguard" ? objects(raw.peers) : [];
  if (peers.length) {
    const nodes: ProxyNode[] = [];
    peers.forEach((peer, peerIndex) => {
      if (nodes.length >= maxNodes) return;
      const peerSettings: NodeMap = { ...settings };
      const peerExtensions = { ...extensions };
      move(peer, peerSettings, "public_key", "public-key");
      move(peer, peerSettings, "pre_shared_key", "pre-shared-key");
      move(peer, peerSettings, "reserved");
      move(peer, peerSettings, "persistent_keepalive_interval", "persistent_keepalive_interval");
      if (peer.keepalive !== undefined && peerSettings.persistent_keepalive_interval === undefined) {
        peerSettings.persistent_keepalive_interval = peer.keepalive;
      }
      addUnknownExtensions(peer, new Set([
        "address", "server", "port", "server_port", "public_key", "pre_shared_key", "reserved",
        "keepalive", "persistent_keepalive_interval",
      ]), peerExtensions, `peers[${peerIndex}]`);
      const endpoint = scalar(peer.address ?? peer.server);
      const peerPort = peer.port ?? peer.server_port ?? basePort;
      const peerSource = { ...source, location: childPath(source, `peers[${peerIndex}]`) };
      const node = makeNode(protocolName, name, endpoint || baseServer, peerPort, peerSettings, peerExtensions, { ...raw, peer }, peerSource, ordinal + peerIndex, diagnostics);
      if (node) nodes.push(node);
    });
    return nodes;
  }
  if (protocol === "wireguard") {
    move(raw, settings, "peer_public_key", "public-key");
    move(raw, settings, "public_key", "public-key");
    move(raw, settings, "pre_shared_key", "pre-shared-key");
  }
  const node = makeNode(protocolName, name, baseServer, basePort, settings, extensions, raw, source, ordinal, diagnostics);
  return node ? [node] : [];
}

function childPath(source: NodeSource, child: string): string {
  return source.location ? `${source.location}/${child}` : child;
}

function mapXrayStream(settings: NodeMap, extensions: NodeMap, rawStream: unknown, protocolName: string): void {
  const stream = object(rawStream);
  const network = networkName(scalar(stream.network) || "tcp");
  const settingKey = network === "httpupgrade" ? "httpupgradeSettings"
    : network === "xhttp" ? "xhttpSettings" : `${network}Settings`;
  const rawTransport = object(stream[settingKey] ?? (network === "xhttp" ? stream.splithttpSettings : undefined));
  mapTransport(settings, extensions, network, rawTransport);

  const security = scalar(stream.security).toLowerCase();
  const tls = object(security === "reality" ? stream.realitySettings : stream.tlsSettings);
  if (security === "tls" || security === "reality") settings.tls = true;
  move(tls, settings, "serverName", "servername");
  move(tls, settings, "allowInsecure", "skip-cert-verify");
  move(tls, settings, "alpn");
  move(tls, settings, "fingerprint", "client-fingerprint");
  move(tls, settings, "pinnedPeerCertSha256", "fingerprint");
  if (security === "reality") {
    settings["reality-opts"] = {
      ...(tls.password !== undefined || tls.publicKey !== undefined ? { "public-key": tls.password ?? tls.publicKey } : {}),
      ...(tls.shortId !== undefined ? { "short-id": tls.shortId } : {}),
      ...(tls.keyShare !== undefined || tls.key_share !== undefined ? { key_share: tls.keyShare ?? tls.key_share } : {}),
    };
  }
  if (tls.echConfigList !== undefined) settings["ech-opts"] = { enabled: true, config: tls.echConfigList };
  const knownTls = new Set(["serverName", "allowInsecure", "alpn", "fingerprint", "pinnedPeerCertSha256", "password", "publicKey", "shortId", "keyShare", "key_share", "echConfigList"]);
  addUnknownExtensions(tls, knownTls, extensions, `stream.${security || "tls"}`);

  if (network === "tcp") {
    const tcp = rawTransport;
    const header = object(tcp.header);
    if (header.type && scalar(header.type) !== "none") settings.headerType = header.type;
    const headerRequest = object(header.request);
    const requestHeaders = object(headerRequest.headers);
    if (headerRequest.path !== undefined) extensions["stream.tcp.header.path"] = headerRequest.path;
    if (requestHeaders.Host !== undefined) extensions["stream.tcp.header.host"] = requestHeaders.Host;
    addUnknownExtensions(header, new Set(["type", "request"]), extensions, "stream.tcp.header");
    addUnknownExtensions(headerRequest, new Set(["path", "headers"]), extensions, "stream.tcp.header.request");
    addUnknownExtensions(requestHeaders, new Set(["Host"]), extensions, "stream.tcp.header.request.headers");
    addUnknownExtensions(tcp, new Set(["header"]), extensions, "stream.tcp");
  }

  const knownStreamFields = new Set([
    "network", "security", "tcpSettings", "rawSettings", "kcpSettings", "wsSettings", "httpSettings",
    "domainsocketSettings", "grpcSettings", "httpupgradeSettings", "splithttpSettings", "xhttpSettings",
    "quicSettings", "tlsSettings", "realitySettings",
  ]);
  if (protocolName === "hysteria") {
    knownStreamFields.add("hysteriaSettings");
    knownStreamFields.add("finalmask");
  }
  addUnknownExtensions(stream, knownStreamFields, extensions, "stream");
}

function endpoint(value: unknown): { server: string; port?: number } {
  const raw = scalar(value);
  if (!raw) return { server: "" };
  try {
    const parsed = new URL(raw.includes("://") ? raw : `http://${raw}`);
    return { server: parsed.hostname.replace(/^\[|\]$/g, ""), ...(parsed.port ? { port: Number(parsed.port) } : {}) };
  } catch {
    return { server: raw };
  }
}

function normalizeXray(
  raw: RecordValue,
  source: NodeSource,
  ordinal: number,
  maxNodes: number,
  diagnostics: Diagnostic[],
): ProxyNode[] {
  // Xray 一个出站可能包含多个服务器或用户，分别生成节点并保留各自来源位置。
  const protocolName = scalar(raw.protocol).toLowerCase();
  const settings = object(raw.settings);
  const extensions: NodeMap = {};
  addUnknownExtensions(raw, new Set(["protocol", "settings", "streamSettings", "tag", "remarks", "name"]), extensions, "xray");
  const streamSettings = object(raw.streamSettings);
  const baseSettings: NodeMap = {};
  mapXrayStream(baseSettings, extensions, streamSettings, protocolName);
  const name = scalar(raw.remarks ?? raw.name ?? raw.tag);
  const create = (server: string, port: unknown, nodeSettings: NodeMap, location: string, rawNode: unknown, index: number, nodeExtensions: NodeMap = extensions) =>
    makeNode(protocolName === "shadowsocks" ? "ss" : protocolName === "hysteria" ? (scalar(settings.version) === "2" ? "hysteria2" : "hysteria") : protocolName,
      name, server, port, { ...baseSettings, ...nodeSettings }, { ...nodeExtensions }, rawNode,
      { ...source, location }, ordinal + index, diagnostics);

  if (protocolName === "wireguard") {
    const wireguardSettings: NodeMap = {};
    const wireguardExtensions = { ...extensions };
    move(settings, wireguardSettings, "secretKey", "private-key");
    move(settings, wireguardSettings, "address");
    move(settings, wireguardSettings, "mtu");
    move(settings, wireguardSettings, "reserved");
    addUnknownExtensions(settings, new Set(["secretKey", "address", "mtu", "reserved", "peers"]), wireguardExtensions, "settings");
    const peers = objects(settings.peers);
    const nodes: ProxyNode[] = [];
    peers.forEach((peer, peerIndex) => {
      if (nodes.length >= maxNodes) return;
      const addressValue = endpoint(peer.endpoint);
      const peerSettings: NodeMap = { ...wireguardSettings };
      const peerExtensions = { ...wireguardExtensions };
      move(peer, peerSettings, "publicKey", "public-key");
      move(peer, peerSettings, "preSharedKey", "pre-shared-key");
      move(peer, peerSettings, "keepAlive", "persistent_keepalive_interval");
      addUnknownExtensions(peer, new Set(["endpoint", "publicKey", "preSharedKey", "keepAlive"]), peerExtensions, `settings.peers[${peerIndex}]`);
      const node = create(addressValue.server, addressValue.port, peerSettings, childPath(source, `peers[${peerIndex}]`), { ...raw, peer }, peerIndex, peerExtensions);
      if (node) nodes.push(node);
    });
    return nodes;
  }

  if (protocolName === "hysteria") {
    const address = scalar(settings.address);
    const port = settings.port;
    const stream = object(streamSettings.hysteriaSettings);
    const mask = object(streamSettings.finalmask);
    const quicParams = object(mask.quicParams);
    const udpHop = object(quicParams.udpHop);
    const nodeSettings: NodeMap = { password: stream.auth };
    if (udpHop.ports !== undefined) nodeSettings.ports = udpHop.ports;
    const udp = objects(mask.udp).find(item => item.type === "salamander");
    if (udp) {
      nodeSettings.obfs = "salamander";
      nodeSettings["obfs-password"] = object(udp.settings).password;
    }
    const hysteriaExtensions = { ...extensions };
    addUnknownExtensions(settings, new Set(["version", "address", "port"]), hysteriaExtensions, "settings");
    addUnknownExtensions(stream, new Set(["auth"]), hysteriaExtensions, "stream.hysteria");
    addUnknownExtensions(mask, new Set(["quicParams", "udp"]), hysteriaExtensions, "stream.finalmask");
    addUnknownExtensions(quicParams, new Set(["udpHop"]), hysteriaExtensions, "stream.finalmask.quicParams");
    addUnknownExtensions(udpHop, new Set(["ports"]), hysteriaExtensions, "stream.finalmask.quicParams.udpHop");
    for (const [udpIndex, udpEntry] of objects(mask.udp).entries()) {
      if (udpEntry.type !== "salamander") hysteriaExtensions[`stream.finalmask.udp[${udpIndex}].type`] = udpEntry.type;
      addUnknownExtensions(udpEntry, new Set(["type", "settings"]), hysteriaExtensions, `stream.finalmask.udp[${udpIndex}]`);
      addUnknownExtensions(
        object(udpEntry.settings),
        udpEntry.type === "salamander" ? new Set(["password"]) : new Set(),
        hysteriaExtensions,
        `stream.finalmask.udp[${udpIndex}].settings`,
      );
    }
    const node = create(address, port, nodeSettings, source.location ?? "", raw, 0, hysteriaExtensions);
    return node ? [node] : [];
  }

  const serverCollection = protocolName === "vmess" || protocolName === "vless" ? "vnext" : "servers";
  const hasServerList = Array.isArray(settings[serverCollection]) && objects(settings[serverCollection]).length > 0;
  const standardSettingFields = hasServerList ? new Set([serverCollection]) : new Set([
    "vnext", "servers", "address", "port", "id", "alterId", "security", "encryption", "flow",
    "method", "password", "user", "pass",
  ]);
  addUnknownExtensions(settings, standardSettingFields, extensions, "settings");
  let servers = protocolName === "vmess" || protocolName === "vless" ? objects(settings.vnext) : objects(settings.servers);
  if (!servers.length && settings.address) servers = [settings];
  const nodes: ProxyNode[] = [];
  for (const [serverIndex, server] of servers.entries()) {
    const serverUsers = objects(server.users);
    const users = serverUsers.length ? serverUsers : [server];
    for (const [userIndex, user] of users.entries()) {
      if (nodes.length >= maxNodes) return nodes;
      const nodeSettings: NodeMap = {};
      move(server, nodeSettings, "method", "cipher");
      move(server, nodeSettings, "password");
      move(user, nodeSettings, "id", "uuid");
      move(user, nodeSettings, "alterId");
      move(user, nodeSettings, "security", "cipher");
      move(user, nodeSettings, "flow");
      move(user, nodeSettings, "encryption");
      move(user, nodeSettings, "pass", "password");
      move(user, nodeSettings, "user", "username");
      const nodeExtensions = { ...extensions };
      const knownServerFields = serverUsers.length ? new Set(["address", "port", "users", "method", "password"])
        : new Set(["address", "port", "users", "method", "password", "id", "alterId", "security", "encryption", "flow", "user", "pass"]);
      const knownUserFields = new Set(["id", "alterId", "security", "flow", "encryption", "pass", "user"]);
      if (server !== settings) addUnknownExtensions(server, knownServerFields, nodeExtensions, `settings.${serverCollection}[${serverIndex}]`);
      if (serverUsers.length) addUnknownExtensions(user, knownUserFields, nodeExtensions, `settings.${serverCollection}[${serverIndex}].users[${userIndex}]`);
      const node = create(
        scalar(server.address),
        server.port,
        nodeSettings,
        childPath(source, `${serverCollection}[${serverIndex}]${serverUsers.length ? `.users[${userIndex}]` : ""}`),
        { ...raw, server, user },
        nodes.length,
        nodeExtensions,
      );
      if (node) nodes.push(node);
    }
  }
  if (!nodes.length && servers.length === 0) {
    diagnostics.push(diagnostic(context(source, source.location ?? "", "native.parse"), "no_native_nodes", "warning", `Xray ${protocolName} settings did not contain a usable server.`));
  }
  return nodes;
}

function isCandidate(value: RecordValue): boolean {
  if ("protocol" in value) return true;
  const type = scalar(value.type).toLowerCase();
  if (type === "wireguard" && Array.isArray(value.peers)) return true;
  if ("type" in value && ("server" in value || "server_port" in value || "port" in value)) return true;
  return "add" in value && "id" in value;
}

function collectCandidates(value: unknown, source: NodeSource, maxCandidates: number): { candidates: NativeCandidate[]; truncated: boolean } {
  const candidates: NativeCandidate[] = [];
  const seen = new WeakSet<object>();
  let truncated = false;
  const visit = (item: unknown, location: string, depth: number) => {
    if (depth > 64 || item === null || typeof item !== "object" || candidates.length >= maxCandidates) {
      if (candidates.length >= maxCandidates) truncated = true;
      return;
    }
    if (seen.has(item)) return;
    seen.add(item);
    if (Array.isArray(item)) {
      for (const [index, child] of item.entries()) {
        if (candidates.length >= maxCandidates) { truncated = true; break; }
        visit(child, childPath({ ...source, location }, `[${index}]`), depth + 1);
      }
      return;
    }
    const record = item as RecordValue;
    for (const key of ["outbounds", "endpoints", "proxies"]) {
      if (Array.isArray(record[key])) {
        for (const [index, child] of (record[key] as unknown[]).entries()) {
          if (candidates.length >= maxCandidates) { truncated = true; break; }
          visit(child, childPath({ ...source, location }, `${key}[${index}]`), depth + 1);
        }
        return;
      }
    }
    if (isCandidate(record)) {
      candidates.push({ value: record, location });
    }
  };
  visit(value, source.location ?? "", 0);
  return { candidates, truncated };
}

export function normalizeNativeValue(value: unknown, source: NodeSource, maxNodes = Number.POSITIVE_INFINITY): NativeParseResult {
  // 候选数和输出节点数分别限流，跳过不支持项时仍继续扫描后续有效节点。
  const diagnostics: Diagnostic[] = [];
  const nodeLimit = Number.isFinite(maxNodes) ? Math.max(0, maxNodes) : Number.POSITIVE_INFINITY;
  const { candidates, truncated: candidateCollectionTruncated } = collectCandidates(value, source, MAX_NATIVE_CANDIDATES);
  const nodes: ProxyNode[] = [];
  let nodeLimitReached = false;

  for (const [index, candidate] of candidates.entries()) {
    const remaining = nodeLimit - nodes.length;
    if (remaining <= 0) { nodeLimitReached = true; break; }
    const candidateSource = { ...source, location: candidate.location || childPath(source, `node[${index}]`) };
    let produced: ProxyNode[];
    if ("protocol" in candidate.value) {
      produced = normalizeXray(candidate.value, candidateSource, index, remaining + 1, diagnostics);
    } else if ("add" in candidate.value && "id" in candidate.value) {
      const payload = candidate.value;
      const network = scalar(payload.net) || "tcp";
      const settings: NodeMap = {
        uuid: payload.id,
        alterId: Number(payload.aid ?? 0),
        cipher: scalar(payload.scy) || "auto",
        headerType: scalar(payload.type) || "none",
        network,
      };
      if (payload.tls) settings.tls = true;
      if (payload.sni) settings.sni = payload.sni;
      if (payload.alpn) settings.alpn = payload.alpn;
      if (payload.fp) settings["client-fingerprint"] = payload.fp;
      if (payload.allowInsecure !== undefined) settings["skip-cert-verify"] = payload.allowInsecure;
      if (payload.packetEncoding !== undefined) settings["packet-encoding"] = payload.packetEncoding;
      if (payload.xhttpOptions !== undefined) settings["xhttp-opts"] = payload.xhttpOptions;
      const transportOptions: NodeMap = {};
      for (const key of ["path", "host", "serviceName", "ed", "eh"]) move(payload, transportOptions, key);
      if (network !== "tcp") mapTransport(settings, {}, network, transportOptions);
      const node = makeNode("vmess", scalar(payload.ps), scalar(payload.add), payload.port, settings, {}, payload, candidateSource, index, diagnostics);
      produced = node ? [node] : [];
    } else {
      produced = normalizeSingBox(candidate.value, candidateSource, index, remaining + 1, diagnostics);
    }
    nodes.push(...produced.slice(0, remaining + 1));
    if (nodes.length > nodeLimit) { nodeLimitReached = true; break; }
  }

  if (nodes.length > nodeLimit) nodes.length = nodeLimit;
  if (candidates.length === 0 && !candidateCollectionTruncated) {
    diagnostics.push(diagnostic(context(source, source.location ?? "", "native.parse"), "no_native_nodes", "warning", "Native configuration did not contain a proxy outbound or proxy list."));
  }
  if (nodeLimitReached) {
    diagnostics.push(diagnostic(context(source, source.location ?? "", "native.parse"), "node_limit", "warning", `Native proxy count was capped at ${nodeLimit}.`));
  }
  if (candidateCollectionTruncated) {
    diagnostics.push(diagnostic(context(source, source.location ?? "", "native.parse"), "native_candidate_limit", "warning", `Native candidate parsing stopped after ${MAX_NATIVE_CANDIDATES} entries.`));
  }
  return { nodes, diagnostics, truncated: nodeLimitReached || candidateCollectionTruncated };
}
