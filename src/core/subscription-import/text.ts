// 与 Android SubscriptionTextNormalizer 保持一致：配置内的 URL 和编码字段不参与展开。
const URI = /(?:vless|vmess|trojan|hysteria2|hy2|anytls|tuic|naive(?:\+https)?|wireguard|masque|ss|socks(?:4a|4|5)?|https?)\\?:\/\/[^\s<>"`]+/gi;
const URI_LIST_SEPARATOR = /[,;，；](?=(?:https?|vless|vmess|trojan|hysteria2|hy2|anytls|tuic|naive(?:\+https)?|wireguard|masque|ss|socks(?:4a|4|5)?)\\?:\/\/)/gi;
const YAML_KEY = /^[A-Za-z_][A-Za-z0-9_-]*\s*:(?:\s.*|$)/;
const YAML_LIST = /^-\s+(?:[A-Za-z_][A-Za-z0-9_-]*\s*:.*|\{.*)/;
const ENCODED_TOKEN = /(?<!\S)(?:base64:)?[A-Za-z0-9+/_=-]{8,}(?!\S)/g;

export function encodeBase64(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function decodeBase64(value: string): string | null {
  const compact = value.replace(/^base64:/, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact) || compact.length % 4 === 1) return null;
  try {
    const binary = atob(compact.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - compact.length % 4) % 4));
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(binary, c => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

function encodedCandidate(value: string) {
  const candidate = value.replace(/^base64:/, "").trim();
  return candidate.length >= 8 && /^[A-Za-z0-9+/_=-]+$/.test(candidate);
}

function decodedText(value: string) {
  if (!encodedCandidate(value.replace(/\s+/g, ""))) return null;
  const text = decodeBase64(value);
  return text?.trim() && text !== value && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text) ? text : null;
}

export function isJsonContent(value: string) {
  return value.startsWith("{") || value.startsWith("[") && !/^\[[^\]]*\]\(https?:\/\//i.test(value);
}

export function isYamlContent(value: string) {
  return /^(?:-\s+)?[A-Za-z_][A-Za-z0-9_-]*\s*:(?:\s|$)|^-\s+\{/m.test(value);
}

export function extractUris(value: string) {
  const markdown = value.replace(/\[[^\]]*\]\(([^)\s]+)\)/g, "$1");
  return Array.from(markdown.matchAll(URI)).flatMap(({ 0: uri }) => {
    // 普通 URL 列表可能在逗号或分号后继续，需要继续拆分。
    if (/^https?:\/\//i.test(uri)) {
      return Array.from(uri.replace(URI_LIST_SEPARATOR, "\n").matchAll(URI), m => m[0]);
    }
    // 节点 URI 的 query 本身可能包含以逗号分隔的 https 地址，不能把查询参数误拆成订阅。
    return [uri];
  }).map(uri => uri.replace(/\\:\/\//g, "://").replace(/\\@/g, "@"));
}

export function subscriptionFragments(value: string, depth = 0): string[] {
  const content = value.trim().replace(/^\uFEFF/, "");
  if (!content) return [];
  if (depth < 32) {
    const decoded = decodedText(content);
    if (decoded) return subscriptionFragments(decoded, depth + 1);
  }
  const result: string[] = [];
  const lines = content.split(/\r\n?|\n/);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line || line === "---" || line === "..." || line.startsWith("```")) { index++; continue; }
    if (isJsonContent(line)) {
      let balance = 0, quoted = false, escaped = false, started = false, complete = false;
      const block: string[] = [];
      do {
        const current = lines[index];
        let consumed = current.length;
        for (let i = 0; i < current.length; i++) {
          const char = current[i];
          if (quoted) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') quoted = false;
          } else if (char === '"') quoted = true;
          else if (char === "{" || char === "[") { balance++; started = true; }
          else if (char === "}" || char === "]") balance--;
          complete = started && balance === 0 && !quoted;
          if (complete) { consumed = i + 1; break; }
        }
        block.push(current.slice(0, consumed));
        const rest = current.slice(consumed);
        if (complete && rest.trim()) lines[index] = rest;
        else index++;
        if (!complete && index < lines.length) {
          const next = lines[index].trim();
          if (next === "---" || YAML_KEY.test(next) || extractUris(next)[0] === next || encodedCandidate(next)) break;
        }
      } while (index < lines.length && !complete);
      result.push(block.join("\n").trim());
      continue;
    }
    if (YAML_KEY.test(line) || YAML_LIST.test(line)) {
      const block: string[] = [];
      do {
        block.push(lines[index++]);
        if (index >= lines.length) break;
        const next = lines[index].trim();
        const topLevel = !/^\s/.test(lines[index]);
        if (topLevel && (next === "---" || next.startsWith("```") || isJsonContent(next) || encodedCandidate(next) ||
          extractUris(next)[0] === next || next && !YAML_KEY.test(next) && !next.startsWith("#") && !next.startsWith("-"))) break;
      } while (true);
      result.push(block.join("\n").trim());
      continue;
    }
    if (depth < 32 && encodedCandidate(line)) {
      let end = index + 1;
      while (end < lines.length && encodedCandidate(lines[end].trim())) end++;
      const decoded = decodedText(lines.slice(index, end).join("\n"));
      if (decoded) { result.push(...subscriptionFragments(decoded, depth + 1)); index = end; continue; }
      const decodedLine = decodedText(line);
      if (decodedLine) { result.push(...subscriptionFragments(decodedLine, depth + 1)); index++; continue; }
    }
    let start = 0;
    if (depth < 32) {
      for (const match of lines[index].matchAll(ENCODED_TOKEN)) {
        const decoded = decodedText(match[0]);
        if (!decoded) continue;
        const prefix = lines[index].slice(start, match.index).trim();
        if (prefix) result.push(prefix);
        result.push(...subscriptionFragments(decoded, depth + 1));
        start = match.index + match[0].length;
      }
    }
    const rest = lines[index].slice(start).trim();
    if (rest) result.push(rest);
    index++;
  }
  return result;
}
