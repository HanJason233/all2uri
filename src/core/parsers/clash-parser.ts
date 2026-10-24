import { parseDocument } from "yaml";
import { diagnostic } from "../diagnostics/index.ts";
import type { Diagnostic } from "../diagnostics/index.ts";
import { createProxyNode, normalizeProtocol } from "../model/proxy-node.ts";
import type { NodeMap, NodeSource, ProxyNode } from "../model/proxy-node.ts";
import { isYamlContent } from "../subscription-import/text.ts";
import { parseNativeValue } from "./native-parser.ts";
import { childLocation, parserResult, type ContentParser } from "./types.ts";

function asMap(value: unknown): NodeMap | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as NodeMap : null;
}

function clashContext(source: NodeSource) {
  return { sourceId: source.sourceId, stage: "clash.parse", ...(source.location ? { location: source.location } : {}) };
}

function parseFlatProxy(value: unknown, source: NodeSource, ordinal: number): { node: ProxyNode | null; diagnostics: Diagnostic[] } {
  const proxy = asMap(value);
  const diagnostics: Diagnostic[] = [];
  if (!proxy) {
    diagnostics.push(diagnostic(clashContext(source), "invalid_proxy", "error", "Proxy entry is not an object."));
    return { node: null, diagnostics };
  }
  const type = String(proxy.type ?? "");
  const version = String(proxy.version ?? "").toLowerCase();
  const protocolName = type.toLowerCase() === "socks" && version === "4" ? "socks4"
    : type.toLowerCase() === "socks" && version === "4a" ? "socks4a"
      : type.toLowerCase() === "hysteria" && version === "2" ? "hysteria2"
        : type;
  const protocol = normalizeProtocol(protocolName);
  if (!protocol) {
    diagnostics.push(diagnostic(clashContext(source), "unsupported_protocol", "warning", `Unsupported proxy type: ${type || "(empty)"}.`, "type"));
    return { node: null, diagnostics };
  }
  const server = String(proxy.server ?? "").trim();
  const port = Number(proxy.port);
  if (!server || !Number.isInteger(port) || port < 1 || port > 65535) {
    diagnostics.push(diagnostic(clashContext(source), "invalid_endpoint", "error", "Proxy entry is missing a server or valid port.", "server/port"));
    return { node: null, diagnostics };
  }
  const settings: NodeMap = { ...proxy };
  if (protocol === "ss" && settings.cipher === undefined && settings.method !== undefined) settings.cipher = settings.method;
  if (protocol === "naive" && settings.username === undefined && settings.user !== undefined) settings.username = settings.user;
  delete settings.type;
  delete settings.server;
  delete settings.port;
  delete settings.name;
  const name = String(proxy.name ?? `${protocol} ${server}:${port}`);
  const node = createProxyNode({ protocol, name, server, port, settings, source, raw: proxy, ordinal });
  return { node, diagnostics };
}

function parseList(values: unknown[], source: NodeSource, diagnostics: Diagnostic[], start = 0, maxNodes = Number.POSITIVE_INFINITY): ProxyNode[] {
  const nodes: ProxyNode[] = [];
  values.slice(0, maxNodes).forEach((value, index) => {
    const parsed = parseFlatProxy(value, { ...source, location: childLocation(source, `proxies[${start + index}]`) }, start + index);
    diagnostics.push(...parsed.diagnostics);
    if (parsed.node) nodes.push(parsed.node);
  });
  if (values.length > maxNodes) {
    diagnostics.push(diagnostic({ sourceId: source.sourceId, stage: "clash.parse" }, "node_limit", "warning", `Proxy count was capped at ${maxNodes}.`));
  }
  return nodes;
}

export const clashParser: ContentParser = {
  id: "clash-yaml",
  detect(content) {
    return isYamlContent(content) || /(?:^|\n)\s*proxies\s*:/.test(content);
  },
  parse(content, source, maxNodes = Number.POSITIVE_INFINITY) {
    const diagnostics: Diagnostic[] = [];
    let document;
    try { document = parseDocument(content, { version: "1.1", uniqueKeys: true }); }
    catch {
      diagnostics.push(diagnostic(clashContext(source), "invalid_yaml", "error", "Clash configuration is not valid YAML."));
      return parserResult([], diagnostics);
    }
    if (document.errors.length) {
      diagnostics.push(diagnostic(clashContext(source), "invalid_yaml", "error", document.errors[0].message));
      return parserResult([], diagnostics);
    }
    const value: unknown = document.toJS({ maxAliasCount: 100 });
    const formatSource = { ...source, format: source.format === "mihomo-yaml" ? "mihomo-yaml" : "clash-yaml" };
    if (Array.isArray(value)) return parserResult(parseList(value, formatSource, diagnostics, 0, maxNodes), diagnostics);
    const root = asMap(value);
    if (!root) {
      diagnostics.push(diagnostic(clashContext(source), "invalid_yaml_root", "error", "Clash configuration root is not an object or list."));
      return parserResult([], diagnostics);
    }
    if ("outbounds" in root || "endpoints" in root) {
      const native = parseNativeValue(root, formatSource, maxNodes);
      return parserResult(native.nodes, [...diagnostics, ...native.diagnostics]);
    }
    if (Array.isArray(root.proxies)) {
      return parserResult(parseList(root.proxies, formatSource, diagnostics, 0, maxNodes), diagnostics);
    }
    if ("type" in root && "server" in root && "port" in root) {
      const parsed = parseFlatProxy(root, { ...formatSource, location: childLocation(source, "proxy") }, 0);
      diagnostics.push(...parsed.diagnostics);
      return parserResult(parsed.node ? [parsed.node] : [], diagnostics);
    }
    diagnostics.push(diagnostic(clashContext(source), "no_proxy_section", "warning", "YAML did not contain a proxies, outbounds or single proxy section."));
    return parserResult([], diagnostics);
  },
};
