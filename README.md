# all2uri

all2uri 是一个完全在本机运行的 Windows 桌面智能导入与订阅转换工具，支持将远程订阅、节点 URI 和本地配置文件转换为标准节点 URI。

## 功能

- 支持一次输入多个 HTTP/HTTPS 订阅地址，并可设置 1–20 个来源的并发拉取（默认 3）。
- 支持从剪贴板粘贴或导入 UTF-8 本地文件，并与远程订阅混合处理。
- 使用 Rust `reqwest` 发起请求，不受 WebView 浏览器 CORS、CSP 或混合内容限制。
- 支持 Basic Auth（URL 中的 `user:pass@host`）、gzip、brotli 和 deflate。
- 自动尝试常见订阅客户端 User-Agent，也可手动选择或输入自定义值。
- 可选择跳过 TLS 证书验证，适用于证书异常或自签名的可信订阅源。
- 响应上限、最大重定向次数和拉取并发数可在“处理”版块的设置中调整。
- 支持 Base64 订阅、Clash YAML、sing-box/Xray JSON、直接节点 URI，并覆盖客户端智能导入支持的节点协议。
- 支持对节点 URI 自动去重（可在“输出”设置中关闭），并支持复制全部或保存为 UTF-8 `.txt` 文件。
- 三个工作区保持固定高度，下方提供独立日志栏；内容过多时在区域内滚动，并可展开查看详情。
- 处理栏显示整体进度与状态，远程订阅的开始、成功、失败和最终汇总统一记录在底部日志栏。
- 请求和转换均在本机完成，不经过 Worker。

## 支持类型

以下内容可以直接粘贴、从本地文件导入，也可以作为远程订阅返回内容：

- Base64 订阅：支持标准 / URL-safe、无填充、换行包裹及多层递归解码。
- Clash YAML：支持 `proxies`、单个代理对象、代理列表，以及 `outbounds` 原生配置。
- sing-box JSON：支持 `outbounds`、`endpoints`、`proxies`，以及单个出站对象。
- Xray JSON：支持 `outbounds`、`vnext` / `servers`，多服务器和多用户会拆分为独立 URI。
- 直接节点 URI、Markdown 链接、URI 列表和混合内容。
- 支持多份 YAML / JSON / URI 文档与远程 URL 混合导入。

节点协议：

| 客户端类型 | 输出 URI | 兼容配置类型 / 别名 |
| --- | --- | --- |
| SOCKS5 | `socks5://` | `socks`、`socks5` |
| SOCKS4 / SOCKS4a | `socks4://`、`socks4a://` | `socks4`、`socks4a` |
| Shadowsocks | `ss://` | `ss`、`shadowsocks` |
| VMess | `vmess://` | `vmess` |
| VLESS | `vless://` | `vless` |
| Trojan | `trojan://` | `trojan` |
| Hysteria 2 | `hysteria2://`（`hy2://` 可直接输入） | `hysteria2`、`hy2`；Xray `hysteria`（version 2） |
| AnyTLS | `anytls://` | `anytls` |
| TUIC | `tuic://` | `tuic` |
| Naive | `naive+https://` | `naive`、`naive+https` |
| WireGuard | `wireguard://` | `wireguard`、`wg` |
| MASQUE | `masque://` | `masque` |

HTTP/HTTPS 仅作为远程订阅地址识别，不会作为 HTTP 代理节点输出。

Xray JSON 中的 `shadowsocks` 会自动映射为 `ss`；其他 `protocol` 与上表同名。TLS / Reality / ECH、WebSocket / gRPC / HTTPUpgrade / xHTTP、Shadowsocks 插件与 `udp-over-tcp`、WireGuard 高级参数会尽量原样保留。

当前不支持 SSR、Snell、Hysteria 1、Juicity、Mieru、ShadowTLS 等客户端未接入的协议；这些节点会被跳过，不会影响同批其他节点。

## 使用

1. 从 Release 安装并启动程序，或按下方说明自行构建。
2. 在“订阅 / 节点内容”中输入远程订阅 URL，或粘贴/导入本地节点、Base64、Clash YAML、sing-box / Xray JSON。
3. 可在“输入”设置中调整 User-Agent 和证书验证，在“处理”设置中调整请求限制，在“输出”设置中调整自动去重。
4. 点击“开始转换”。
5. 在底部日志栏查看各远程订阅的处理结果，转换完成后复制全部节点 URI，或保存为文本文件。

HTTP/HTTPS 仍按订阅 URL 处理；本地内容只在本机解析，不会上传。导入文件必须是 UTF-8 文本，单个文件最大 64 MiB。

## 技术栈

- Tauri 2
- Vanilla TypeScript + Vite
- Rust + `reqwest`
- `yaml` 解析器

前端只负责 Windows 程序内的界面和 URI 解析；网络请求通过 Tauri command 交给 Rust 完成，因此不会重新受到 WebView 跨域策略限制。安装后的程序直接加载内置资源，不依赖本地 HTTP 服务。

## 构建

环境要求：

- Windows 10/11
- Node.js 20 或更高版本
- Rust stable
- Microsoft WebView2 Runtime（Windows 11 通常已内置）
- 构建 NSIS 安装包所需的本机工具链

安装依赖：

```powershell
npm install
```

执行测试：

```powershell
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

构建 Windows 安装包：

```powershell
npm run tauri:build
```

产物默认位于：

```text
src-tauri/target/release/bundle/nsis/
```

如果当前网络无法直接访问 crates.io，可在构建前设置 HTTP 代理：

```powershell
$env:HTTP_PROXY = 'http://127.0.0.1:10808'
$env:HTTPS_PROXY = 'http://127.0.0.1:10808'
$env:ALL_PROXY = 'http://127.0.0.1:10808'
```

## 安全与边界

- 仅允许 HTTP/HTTPS 订阅地址，重定向目标也必须是 HTTP/HTTPS。
- 连接超时 10 秒，请求总超时 30 秒；最大重定向默认 10 次，可在设置中调整为 0–50 次。
- 拉取并发数默认 3，可在设置中调整为 1–20；设置过高可能触发订阅服务限流。
- 单个订阅响应默认上限 2 MiB，可在设置中调整为 1–64 MiB；导出文件最大 64 MiB。
- 默认保持 TLS 证书校验；仅在手动开启“跳过证书验证”后关闭，请勿对不可信订阅源使用。
- URL 中的账号密码只用于 Basic Auth，并会从最终显示地址中移除。
- 保存功能只接受绝对路径的 `.txt` 文件。
- 程序不保存订阅地址历史，也不会把订阅内容发送到其他服务。
- 本地文件仅在用户主动选择后读取，并限制为 UTF-8 文本和 64 MiB。

订阅服务本身仍可能根据 IP、User-Agent、鉴权信息或访问频率限制请求；这类限制由服务端决定，本工具无法绕过。TLS 证书错误、网络不可达和目标服务器拒绝访问也会显示在对应来源的错误信息中。

## 目录结构

```text
all2uri/
├─ src/                         # 前端界面、解析与转换逻辑
│  └─ core/subscription-import/ # 订阅格式识别与 URI 转换
├─ src-tauri/                   # Tauri/Rust 原生层
│  └─ src/lib.rs                # HTTP 拉取、Basic Auth 与文件保存
├─ tests/                       # TypeScript 解析测试
├─ index.html
├─ package.json
└─ README.md
```
