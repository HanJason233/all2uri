# all2uri

all2uri 是一款 Windows 桌面工具，可将远程订阅、本地配置和节点分享链接转换为标准节点 URI，并在表格中查看、筛选、复制或保存结果。

## 功能

### 输入

- 可在输入框中混合填写多个 HTTP/HTTPS 订阅地址和本地节点内容。
- 支持从剪贴板导入、选择多个本地文件，或通过二维码导入。
- 二维码支持全屏扫描、选择图片和摄像头实时扫描；识别到的内容会写入输入框。
- 输入设置可选择自动识别或指定订阅 User-Agent，设置最大重定向次数、远程订阅超时和并发请求，并控制本机/局域网访问及 TLS 证书验证。
- 自动 User-Agent 无法识别订阅内容时，会尝试常见客户端 User-Agent。

### 转换与输出

- 支持 Base64 订阅、Clash/mihomo YAML、sing-box/Xray JSON、节点 URI、Markdown 链接和混合内容。
- 转换结果显示在表格中，包含序号、类型、别名、地址、端口、入口地区和入口类型。
- 表格列宽可拖动调整，也可通过“初始化列宽”恢复默认宽度。
- 运行“链路类型”测试时，会比较节点服务器入口与代理出口，识别直连、普通中转或 CDN 中转；Cloudflare 等 CDN 信息显示在链路类型结果中。
- 地区识别可使用节点名称匹配、本地 GeoIP 数据库和远程 API；默认启用这三种方式，可在输出设置中选择查询方式、自行设置并发数（默认 8），并选择内置或自定义 `geoip.dat`。
- “设置筛选”支持协议、地区和 CF 入口条件。CF 入口筛选使用链路类型测试结果，启动软件后需重新检测；复制和保存会遵循当前筛选结果。协议和地区组内多选按“或”匹配，启用筛选但未选择匹配项时，该组不会匹配节点。
- 自动去重默认关闭。开启后按连接参数去重并合并来源记录；“包含有损结果”默认关闭。
- 日志和整体转换进度显示在窗口底部。

## 支持的输入格式

- Base64 订阅：支持标准和 URL-safe 编码、无填充、换行包裹及受 64 MiB 上限约束的递归解码。
- Clash/mihomo YAML：支持 `proxies`、单个代理对象、代理列表和 `outbounds` 原生配置。
- sing-box JSON：支持 `outbounds`、`endpoints`、`proxies` 和单个出站对象。
- Xray JSON：支持 `outbounds`、`vnext` / `servers`；多服务器或多用户会拆分为独立 URI。
- 直接节点 URI、Markdown 链接、URI 列表和混合内容；多份 YAML、JSON、URI 文档也可与远程订阅混合导入。

节点协议：

| 客户端类型 | 输出 URI | 兼容配置类型 / 别名 |
| --- | --- | --- |
| SOCKS5 | `socks5://` | `socks`、`socks5` |
| SOCKS4 / SOCKS4a | `socks4://`、`socks4a://` | `socks4`、`socks4a` |
| Shadowsocks | `ss://` | `ss`、`shadowsocks` |
| VMess | `vmess://` | `vmess` |
| VLESS | `vless://` | `vless` |
| Trojan | `trojan://` | `trojan` |
| Hysteria 2 | `hysteria2://`（也接受 `hy2://` 输入） | `hysteria2`、`hy2`；Xray `hysteria`（version 2） |
| AnyTLS | `anytls://` | `anytls` |
| TUIC | `tuic://` | `tuic` |
| Naive | `naive+https://` | `naive`、`naive+https` |
| WireGuard | `wireguard://` | `wireguard`、`wg` |
| MASQUE | `masque://` | `masque` |

HTTP/HTTPS 只作为远程订阅地址处理，不会作为 HTTP 代理节点输出。Xray JSON 中的 `shadowsocks` 会映射为 `ss`。TLS / Reality / ECH、WebSocket / gRPC / HTTPUpgrade / xHTTP、Shadowsocks 插件、`udp-over-tcp` 和 WireGuard 高级参数会尽量保留。

SSR、Snell、Hysteria 1、Juicity、Mieru、ShadowTLS 等尚未接入的协议会被跳过，不影响同批其他节点的处理。

## 使用

1. 从 [GitHub Releases](https://github.com/HanJason233/all2uri/releases) 下载并安装，或按下方说明自行构建。
2. 在输入框填写订阅地址或节点内容，也可使用剪贴板、文件或二维码按钮导入。
3. 按需通过“输入设置”和“输出设置”调整请求、去重、地区识别等选项。
4. 点击“开始转换”，在底部日志查看来源处理情况和进度。
5. 在输出表格查看节点；需要时调整列宽或设置筛选，再复制结果或保存为文本文件。

## 构建

环境要求：

- Windows 10/11
- Node.js 20 或更高版本
- Rust stable
- Microsoft WebView2 Runtime（Windows 11 通常已内置）
- 构建 NSIS 安装包所需的本机工具链

安装依赖并构建 Windows 安装包：

```powershell
npm install
npm run tauri:build
```

安装包默认输出到：

```text
src-tauri/target/release/bundle/nsis/
```

运行项目测试：

```powershell
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

如果当前网络无法直接访问 crates.io，可在构建前设置 HTTP 代理：

```powershell
$env:HTTP_PROXY = 'http://127.0.0.1:10808'
$env:HTTPS_PROXY = 'http://127.0.0.1:10808'
$env:ALL_PROXY = 'http://127.0.0.1:10808'
```

## 网络与数据处理

- 远程订阅请求由 Rust 原生层发起，不受 WebView 浏览器 CORS 限制；可在输入设置中关闭远程订阅拉取，关闭时跳过输入中的远程地址并继续处理本地内容。订阅 URL 和重定向目标仅允许 HTTP/HTTPS。
- 连接超时为 10 秒；远程订阅总超时默认 30 秒，可设为 1 秒以上。最大重定向默认 10 次，可设为 0 次以上。
- 并发请求默认按订阅数量的 10% 计算，也可设置固定数量或百分比；并发设置没有预设上限，实际并发不超过本次远程订阅数。
- 单批本地内容与远程订阅内容合计最多 64 MiB；本地文件须为 UTF-8 文本。二维码图片、单个远程响应和保存结果也受 64 MiB 上限约束。
- 默认校验 TLS 证书并阻止访问本机、局域网及特殊用途 IP。可在输入设置中手动调整；允许本机/局域网访问后，重定向目标仍会逐个检查。
- 节点名称识别和本地 GeoIP 查询在本机完成。默认启用的远程地区 API 会把待查询的公网节点服务器 IP 发给 `ipwho.is`；可在输出设置中关闭该查询方式。
- 本地文件和节点内容在本机解析，不会作为内容上传到外部服务。程序不保存订阅地址历史；远程订阅服务会收到用户主动请求的订阅地址和 User-Agent。
- 输出保存为 `.txt` 文件，最大 64 MiB。URL 中的账号密码仅用于 Basic Auth，不会保留在最终显示的订阅地址中。

## 技术栈

- Tauri 2
- Vanilla TypeScript + Vite
- Rust + `reqwest`
- `yaml` 解析器

远程网络请求通过 Tauri command 交给 Rust 完成；较大的解析和转换任务放在 Web Worker 中。安装后的程序直接加载内置资源，不依赖本地 HTTP 服务。
