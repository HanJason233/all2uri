import { parseDocument } from "yaml";
import { convertText } from "../pipeline.ts";
import { map, scalar } from "./encode.ts";
import { decodeBase64, extractUris, isJsonContent, isYamlContent, subscriptionFragments, subscriptionFragmentsLimited } from "./text.ts";

export function normalizeRemoteUrl(value: string) {
  if (value.length > 8192 || /[\r\n]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch { return null; }
}

export function detectSubscriptionInput(value: string) {
  const urls = new Set<string>(), local: string[] = [];
  let remainingUris = 100_000;
  let uriLimitReached = false;
  const inputTooLarge = new TextEncoder().encode(value).byteLength > 64 * 1024 * 1024;
  if (inputTooLarge) {
    return {
      urls: [] as string[], local, truncated: true, fragmentsTruncated: false, uriLimitReached: false,
      decodedTooLarge: 0, depthLimited: false, inputTooLarge,
    };
  }
  const expanded = subscriptionFragmentsLimited(value, {
    maxDepth: 16,
    maxFragments: 10000,
    maxDecodedBytes: 64 * 1024 * 1024,
  });
  for (const fragment of expanded.fragments) {
    if (isJsonContent(fragment) || isYamlContent(fragment)) { local.push(fragment); continue; }
    if (remainingUris <= 0) {
      uriLimitReached = extractUris(fragment, 1).length > 0;
      break;
    }
    const found = extractUris(fragment, remainingUris + 1);
    if (found.length > remainingUris) uriLimitReached = true;
    for (const uri of found.slice(0, remainingUris)) {
      if (/^https?:\/\//i.test(uri)) {
        const url = normalizeRemoteUrl(uri);
        if (url) urls.add(url);
      } else local.push(uri);
    }
    remainingUris -= Math.min(found.length, remainingUris);
  }
  return {
    urls: [...urls],
    local,
    truncated: expanded.truncated || uriLimitReached,
    fragmentsTruncated: expanded.truncated,
    uriLimitReached,
    decodedTooLarge: expanded.decodedTooLarge,
    depthLimited: expanded.depthLimited,
    inputTooLarge,
  };
}

/** 对照客户端最终 URI 解析结果，过滤没有服务器或合法端口的分享链接。 */
export function isUsableNode(uri: string): boolean {
  // HTTP/HTTPS 是订阅地址，不作为节点代理 URI。
  if (/^https?:\/\//i.test(uri)) return false;
  const portValid = (port: unknown) => /^\d+$/.test(String(port)) && Number(port) >= 1 && Number(port) <= 65535;
  try {
    if (/^vmess:\/\//i.test(uri)) {
      const payload = map(JSON.parse(decodeBase64(uri.slice(8).split("#", 1)[0]) || "{}"));
      return !!scalar(payload.add) && portValid(payload.port ?? 443);
    }
    let value = uri;
    if (/^ss:\/\//i.test(uri) && !uri.split("#", 1)[0].includes("@")) {
      const decoded = decodeBase64(uri.slice(5).split(/[?#]/, 1)[0]);
      if (decoded) value = "ss://" + decoded;
    }
    // Hysteria2 端口跳跃语法不能交给 URL 直接解析。
    value = value.replace(/^(hysteria2|hy2):\/\/([^/?#]+):(\d+)(?:[-,]\d+)+(?=[/?#]|$)/i, "$1://$2:$3");
    const url = new URL(value);
    if (url.protocol === "vless:" && !decodeURIComponent(url.username).trim()) return false;
    const defaultPort = url.protocol === "http:" ? "80" : /^socks/.test(url.protocol) ? "1080" : url.protocol === "wireguard:" ? "51820" : "443";
    return !!url.hostname && portValid(url.port || defaultPort);
  } catch { return false; }
}

export function toStandardUris(input: string | string[], options: { deduplicate?: boolean } = {}) {
  const content = Array.isArray(input) ? input.join("\n") : input;
  const fragments = Array.isArray(input) ? input : subscriptionFragments(input);
  const structured = fragments.some(fragment => isJsonContent(fragment) || isYamlContent(fragment));
  if (!structured) {
    const direct = fragments.flatMap(fragment => extractUris(fragment)).filter(isUsableNode);
    return options.deduplicate === false ? direct : [...new Set(direct)];
  }
  const converted = convertText(content, "legacy", {
    includeLossy: true,
    deduplicate: false,
  }).uris;
  return options.deduplicate === false ? converted : [...new Set(converted)];
}

export function extractSubscriptionNodeNames(input: string) {
  const names: string[] = [];
  const addName = (value: unknown) => {
    if (typeof value === "string" && value.trim()) names.push(value.trim());
  };
  const collect = (value: unknown, depth = 0) => {
    if (depth > 64 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(item => collect(item, depth + 1));
      return;
    }
    const record = value as Record<string, unknown>;
    for (const key of ["name", "remarks", "ps", "tag"]) addName(record[key]);
    Object.values(record).forEach(item => collect(item, depth + 1));
  };
  const uriName = (uri: string) => {
    if (/^vmess:\/\//i.test(uri)) {
      try {
        const payload = uri.slice(uri.indexOf("://") + 3).split("#", 1)[0];
        const value = JSON.parse(decodeBase64(payload) || "{}");
        return String(value.ps || value.name || "");
      } catch { /* Continue to URI fragment fallback. */ }
    }
    const hashIndex = uri.indexOf("#");
    if (hashIndex < 0) return "";
    try { return decodeURIComponent(uri.slice(hashIndex + 1)); }
    catch { return uri.slice(hashIndex + 1); }
  };

  for (const fragment of subscriptionFragments(input)) {
    try {
      if (isJsonContent(fragment)) {
        collect(JSON.parse(fragment));
      } else if (isYamlContent(fragment)) {
        const doc = parseDocument(fragment, { version: "1.1", uniqueKeys: true });
        if (!doc.errors.length) collect(doc.toJS({ maxAliasCount: 100 }));
      } else {
        extractUris(fragment).forEach(uri => addName(uriName(uri)));
      }
    } catch { /* Ignore malformed fragments and keep scanning the rest. */ }
  }
  return names;
}
