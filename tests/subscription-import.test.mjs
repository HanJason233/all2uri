import assert from "node:assert/strict";
import test from "node:test";
import {
  detectSubscriptionInput,
  isUsableNode,
  toStandardUris,
} from "../src/core/subscription-import/index.ts";
import { decodeBase64, encodeBase64 } from "../src/core/subscription-import/text.ts";

const uuid = "11111111-1111-1111-1111-111111111111";

test("直接节点 URI 可以标准化并过滤无效节点", () => {
  const uri = `vless://${uuid}@direct.example:443?security=tls#direct`;
  assert.deepEqual(toStandardUris(`${uri}\nvless://bad@example.com:70000`), [uri]);
});

test("多层 Base64 订阅可以递归解码", () => {
  const uri = `trojan://secret@base64.example:443#base64`;
  const input = encodeBase64(encodeBase64(encodeBase64(uri)));
  assert.deepEqual(toStandardUris(input), [uri]);
});

test("Clash YAML 可以转换为标准 URI", () => {
  const yaml = `proxies:
  - name: yaml-node
    type: trojan
    server: yaml.example
    port: 443
    password: secret
    sni: yaml.example`;
  const nodes = toStandardUris(yaml);
  assert.equal(nodes.length, 1);
  assert.match(nodes[0], /^trojan:\/\//);
  assert.match(nodes[0], /yaml\.example:443/);
});

test("sing-box JSON 可以转换为标准 URI", () => {
  const config = {
    outbounds: [
      {
        type: "vless",
        tag: "json-node",
        server: "json.example",
        server_port: 443,
        uuid,
        tls: { enabled: true, server_name: "json.example" },
      },
    ],
  };
  const nodes = toStandardUris(JSON.stringify(config));
  assert.equal(nodes.length, 1);
  assert.match(nodes[0], /^vless:\/\//);
  assert.match(nodes[0], new RegExp(uuid));
});

test("混合输入会区分远程订阅与本地节点", () => {
  const uri = `vless://${uuid}@local.example:443`;
  const input = detectSubscriptionInput(`${uri}\nhttps://remote.example/sub`);
  assert.deepEqual(input.urls, ["https://remote.example/sub"]);
  assert.deepEqual(input.local, [uri]);
});

test("节点查询参数中的 URL 不会被误识别为远程订阅", () => {
  const uri = `vless://${uuid}@local.example:443?ech=https://dns.example/query,https://fallback.example/query`;
  const input = detectSubscriptionInput(`${uri}\nhttps://remote.example/sub`);
  assert.deepEqual(input.urls, ["https://remote.example/sub"]);
  assert.deepEqual(toStandardUris(input.local), [uri]);
});

test("无效内容不会抛出异常", () => {
  assert.deepEqual(toStandardUris("not a subscription\n{\"broken\": true}"), []);
});

test("覆盖客户端智能导入的全部节点协议和别名", () => {
  const protocols = [
    "socks", "socks5", "socks4", "socks4a", "ss", "shadowsocks", "vmess", "vless",
    "trojan", "hysteria2", "hy2", "anytls", "tuic", "naive", "wireguard", "wg", "masque",
  ];
  const proxies = protocols.map(type => ({
    type,
    name: type,
    server: "node.example",
    port: 443,
    username: "user",
    password: "pass",
    uuid,
    cipher: "aes-128-gcm",
    "private-key": "private-key",
    "public-key": "public-key",
    ip: "10.0.0.2/32",
  }));
  const nodes = toStandardUris(JSON.stringify({ proxies }));
  assert.equal(nodes.length, protocols.length);
  const expected = {
    socks: "socks5://", socks5: "socks5://", socks4: "socks4://", socks4a: "socks4a://",
    ss: "ss://", shadowsocks: "ss://", vmess: "vmess://", vless: "vless://", trojan: "trojan://",
    hysteria2: "hysteria2://", hy2: "hysteria2://", anytls: "anytls://", tuic: "tuic://",
    naive: "naive+https://", wireguard: "wireguard://", wg: "wireguard://", masque: "masque://",
  };
  protocols.forEach((type, index) => assert.ok(nodes[index].startsWith(expected[type]), `${type}: ${nodes[index]}`));
});

test("HTTP/HTTPS 只识别为订阅地址，不进入本地节点", () => {
  const input = detectSubscriptionInput("http://proxy.example:8080\nhttps://proxy.example:443");
  assert.deepEqual(input.urls, ["http://proxy.example:8080/", "https://proxy.example/"]);
  assert.deepEqual(input.local, []);
  assert.deepEqual(toStandardUris("http://proxy.example:8080\nhttps://proxy.example:443"), []);
});

test("传输、TLS、SS 和 WireGuard 扩展参数保持完整", () => {
  const vless = new URL(toStandardUris(JSON.stringify({
    proxies: [{
      type: "vless", name: "reality-xhttp", server: "edge.example", port: 443, uuid,
      encryption: "mlkem768x25519plus",
      "reality-opts": { "public-key": "public-key", "short-id": "abcd", key_share: "key-share" },
      fragment: true, fragment_fallback_delay: "500ms", record_fragment: true,
      network: "xhttp", "xhttp-opts": { path: "/xhttp", host: "host.example", mode: "auto", extra: { scMaxEachPostBytes: 1000000 } },
    }],
  }))[0]);
  assert.equal(vless.searchParams.get("encryption"), "mlkem768x25519plus");
  assert.equal(vless.searchParams.get("key_share"), "key-share");
  assert.equal(vless.searchParams.get("fragment"), "true");
  assert.equal(vless.searchParams.get("fragment_fallback_delay"), "500ms");
  assert.equal(vless.searchParams.get("record_fragment"), "true");
  assert.equal(vless.searchParams.get("type"), "xhttp");
  assert.equal(JSON.parse(vless.searchParams.get("xhttpOptions")).extra.scMaxEachPostBytes, 1000000);

  const ss = new URL(toStandardUris(JSON.stringify({
    proxies: [{ type: "ss", server: "ss.example", port: 8388, cipher: "aes-128-gcm", password: "pass", "udp-over-tcp": true }],
  }))[0]);
  assert.equal(ss.searchParams.get("udp_over_tcp"), "1");

  const wg = new URL(toStandardUris(JSON.stringify({
    proxies: [{
      type: "wireguard", server: "wg.example", port: 51820,
      "private-key": "private", "public-key": "public", ip: "quic",
      address: "10.0.0.2/32", persistent_keepalive_interval: 25, jc: 4, jmin: 50, jmax: 1000,
    }],
  }))[0]);
  assert.equal(wg.searchParams.get("ip"), "quic");
  assert.equal(wg.searchParams.get("persistent_keepalive_interval"), "25");
  assert.equal(wg.searchParams.get("jc"), "4");
  assert.equal(wg.searchParams.get("jmin"), "50");
  assert.equal(wg.searchParams.get("jmax"), "1000");

  const vmess = JSON.parse(decodeBase64(toStandardUris(JSON.stringify({
    proxies: [{
      type: "vmess", server: "vmess.example", port: 443, uuid,
      network: "xhttp", "xhttp-opts": { path: "/xhttp", host: "host.example", mode: "auto", extra: { scMaxEachPostBytes: 1000000 } },
    }],
  }))[0].slice(8)));
  assert.equal(vmess.net, "xhttp");
  assert.equal(vmess.xhttpOptions.extra.scMaxEachPostBytes, 1000000);
});

test("sing-box 与 Xray 原生字段可以转换为客户端 URI", () => {
  const singBox = new URL(toStandardUris(JSON.stringify({
    outbounds: [{
      type: "vless", tag: "sing-box", server: "sing.example", server_port: 443, uuid,
      encryption: "mlkem768x25519plus",
      tls: {
        enabled: true, server_name: "sni.example",
        reality: { enabled: true, public_key: "public-key", short_id: "abcd", key_share: "key-share" },
        fragment: true, fragment_fallback_delay: "500ms", record_fragment: true,
      },
      transport: { type: "xhttp", path: "/xhttp", host: "host.example", mode: "auto", extra: { scMaxEachPostBytes: 1000000 } },
    }],
  }))[0]);
  assert.equal(singBox.searchParams.get("encryption"), "mlkem768x25519plus");
  assert.equal(singBox.searchParams.get("key_share"), "key-share");
  assert.equal(singBox.searchParams.get("fragment"), "true");
  assert.equal(singBox.searchParams.get("type"), "xhttp");

  const xray = new URL(toStandardUris(JSON.stringify({
    protocol: "vless",
    settings: { vnext: [{ address: "xray.example", port: 443, users: [{ id: uuid, encryption: "none" }] }] },
    streamSettings: {
      network: "tcp", security: "reality",
      realitySettings: { serverName: "sni.example", publicKey: "public-key", shortId: "abcd", keyShare: "key-share" },
    },
  }))[0]);
  assert.equal(xray.searchParams.get("encryption"), "none");
  assert.equal(xray.searchParams.get("key_share"), "key-share");
});

test("直接节点 URI 覆盖客户端全部协议", () => {
  const vmess = "vmess://" + encodeBase64(JSON.stringify({ add: "vmess.example", port: 443, id: uuid }));
  const direct = [
    `vless://${uuid}@vless.example:443#vless`,
    vmess,
    "trojan://pass@trojan.example:443#trojan",
    "hysteria2://pass@hy2.example:443#hysteria2",
    "hy2://pass@hy2alias.example:443#hy2alias",
    "anytls://pass@anytls.example:443#anytls",
    `tuic://${uuid}:pass@tuic.example:443#tuic`,
    "naive://user:pass@naive.example:443#naive",
    "naive+https://user:pass@naive2.example:443#naive2",
    "wireguard://private@wg.example:51820?publickey=public#wireguard",
    "masque://private@masque.example:443?public_key=public&ip=10.0.0.2#masque",
    "ss://YWVzLTEyOC1nY206cGFzcw@ss.example:8388#ss",
    "socks://socks.example:1080#socks",
    "socks4://socks4.example:1080#socks4",
    "socks4a://socks4a.example:1080#socks4a",
    "socks5://socks5.example:1080#socks5",
  ];
  assert.deepEqual(toStandardUris(direct.join("\n")), direct);
  direct.forEach(node => assert.equal(isUsableNode(node), true, node));
});

test("配置别名与版本字段可以正确映射", () => {
  const nodes = toStandardUris(JSON.stringify({
    proxies: [
      { type: "socks", version: "4", server: "socks4.example", port: 1080 },
      { type: "socks", version: "4a", server: "socks4a.example", port: 1080 },
      { type: "hysteria", version: "2", server: "hysteria.example", port: 443, password: "pass" },
      { type: "naive+https", server: "naive.example", port: 443, username: "user", password: "pass" },
      { type: "shadowsocks", server: "ss.example", port: 8388, cipher: "aes-128-gcm", password: "pass" },
    ],
  }));
  assert.deepEqual(nodes.map(node => node.split("://")[0]), [
    "socks4", "socks4a", "hysteria2", "naive+https", "ss",
  ]);
});
