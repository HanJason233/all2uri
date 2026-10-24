import { diagnostic } from "../diagnostics/index.ts";
import type { Diagnostic } from "../diagnostics/index.ts";
import type { NodeMap, ProxyNode } from "../model/proxy-node.ts";

function has(settings: NodeMap, ...keys: string[]): boolean {
  return keys.some(key => {
    const value = settings[key];
    return value !== undefined && value !== null && String(value).trim() !== "";
  });
}

export function validateProxyNode(node: ProxyNode): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const origin = node.sources[0];
  const context = { sourceId: origin?.sourceId ?? "unknown", ...(origin?.location ? { location: origin.location } : {}), nodeId: node.id, stage: "validate" };
  if (!node.server || /[\s/?#@]/.test(node.server)) {
    diagnostics.push(diagnostic(context, "invalid_server", "error", "Server address is empty or invalid.", "server"));
  }
  if (!Number.isInteger(node.port) || node.port < 1 || node.port > 65535) {
    diagnostics.push(diagnostic(context, "invalid_port", "error", "Port must be between 1 and 65535.", "port"));
  }
  const settings = node.settings;
  const required: Record<string, string[][]> = {
    vless: [["uuid"]],
    vmess: [["uuid"]],
    trojan: [["password"]],
    hysteria2: [["password", "auth", "auth-str"]],
    anytls: [["password"]],
    tuic: [["uuid"], ["password"]],
    naive: [["username", "user"], ["password"]],
    wireguard: [["private-key", "private_key"]],
    masque: [["profile"]],
  };
  for (const group of required[node.protocol] ?? []) {
    if (!has(settings, ...group)) {
      diagnostics.push(diagnostic(context, "missing_credentials", "error", `Missing required credential for ${node.protocol}.`, group.join("/")));
    }
  }
  if (node.protocol === "ss" && (!has(settings, "cipher") || !has(settings, "password"))) {
    diagnostics.push(diagnostic(context, "missing_credentials", "error", "Shadowsocks requires cipher and password.", "cipher/password"));
  }
  if (node.protocol === "wireguard" && !has(settings, "public-key", "public_key")) {
    diagnostics.push(diagnostic(context, "missing_public_key", "error", "WireGuard requires a peer public key.", "public-key"));
  }
  if (node.protocol === "masque") {
    const profile = String(settings.profile ?? "cloudflare");
    if (profile !== "standard" && (!has(settings, "private-key", "private_key") || !has(settings, "public-key", "public_key"))) {
      diagnostics.push(diagnostic(context, "missing_masque_keys", "error", "MASQUE requires client and server public keys unless profile is standard.", "private-key/public-key"));
    }
    if (!has(settings, "ip") && !has(settings, "ipv6")) {
      diagnostics.push(diagnostic(context, "missing_masque_address", "error", "MASQUE requires ip or ipv6.", "ip/ipv6"));
    }
  }
  return diagnostics;
}
