use ipnet::IpNet;
use reqwest::{Client, Proxy, StatusCode, redirect::Policy};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    net::{IpAddr, TcpListener},
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use tokio::{net::TcpStream, task::JoinSet};

const DEFAULT_TEST_TIMEOUT_MS: u64 = 10_000;
const DEFAULT_BANDWIDTH_DURATION_MS: u64 = 3_000;
const BANDWIDTH_WARMUP_MS: u64 = 1_000;
const DEFAULT_204_URL: &str = "https://www.google.com/generate_204";
const DEFAULT_BANDWIDTH_URL: &str = "https://speed.cloudflare.com/__down?bytes=25000000";
const EXIT_IP_URL: &str = "https://api.ipify.org";

const CDN_NETS: &[(&str, &str)] = &[
    ("Cloudflare", "103.21.244.0/22"),
    ("Cloudflare", "103.22.200.0/22"),
    ("Cloudflare", "103.31.4.0/22"),
    ("Cloudflare", "104.16.0.0/13"),
    ("Cloudflare", "104.24.0.0/14"),
    ("Cloudflare", "108.162.192.0/18"),
    ("Cloudflare", "131.0.72.0/22"),
    ("Cloudflare", "141.101.64.0/18"),
    ("Cloudflare", "162.158.0.0/15"),
    ("Cloudflare", "172.64.0.0/13"),
    ("Cloudflare", "173.245.48.0/20"),
    ("Cloudflare", "188.114.96.0/20"),
    ("Cloudflare", "190.93.240.0/20"),
    ("Cloudflare", "197.234.240.0/22"),
    ("Cloudflare", "198.41.128.0/17"),
    ("CloudFront", "13.32.0.0/15"),
    ("CloudFront", "13.224.0.0/14"),
    ("CloudFront", "52.84.0.0/15"),
    ("CloudFront", "54.182.0.0/16"),
    ("CloudFront", "54.192.0.0/16"),
    ("CloudFront", "54.230.0.0/16"),
    ("CloudFront", "99.84.0.0/16"),
    ("Fastly", "151.101.0.0/16"),
    ("Fastly", "199.232.0.0/16"),
    ("Gcore", "92.223.0.0/17"),
    ("Gcore", "95.85.0.0/16"),
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeTestRequest {
    server: String,
    port: u16,
    kind: String,
    #[serde(default)]
    outbound: Option<Value>,
    #[serde(default)]
    endpoint: Option<Value>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    duration_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlockResult {
    id: String,
    name: String,
    state: String,
    detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    status_code: Option<u16>,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NodeTestResponse {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    latency_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    download_mbps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status_code: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    link_type: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    entry_ips: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_ip: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cdn_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    unlock: Vec<UnlockResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl NodeTestResponse {
    fn error(message: impl Into<String>) -> Self {
        Self {
            success: false,
            error: Some(message.into()),
            ..Self::default()
        }
    }
}

struct CoreProcess {
    child: Child,
    directory: PathBuf,
    port: u16,
}

impl CoreProcess {
    async fn start(
        app: &tauri::AppHandle,
        outbound: Option<Value>,
        endpoint: Option<Value>,
    ) -> Result<Self, String> {
        let binary = resolve_sing_box(app)?;
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|error| format!("无法分配本地测试端口：{error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| format!("无法读取本地测试端口：{error}"))?
            .port();
        drop(listener);

        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("all2uri-node-test-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&directory)
            .map_err(|error| format!("无法创建测试配置目录：{error}"))?;

        let mut outbounds = Vec::new();
        if let Some(outbound) = outbound {
            outbounds.push(outbound);
        }
        outbounds.push(json!({ "type": "direct", "tag": "direct" }));
        let mut config = json!({
            "log": { "level": "error", "timestamp": false },
            "dns": { "servers": [{ "type": "local", "tag": "dns-local" }] },
            "inbounds": [{
                "type": "mixed",
                "tag": "test-in",
                "listen": "127.0.0.1",
                "listen_port": port
            }],
            "outbounds": outbounds,
            "route": {
                "final": "proxy",
                "default_domain_resolver": "dns-local"
            }
        });
        if let Some(endpoint) = endpoint {
            config["endpoints"] = json!([endpoint]);
        }
        let config_path = directory.join("config.json");
        fs::write(&config_path, serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?)
            .map_err(|error| format!("无法写入测试配置：{error}"))?;

        let mut command = Command::new(&binary);
        command
            .arg("run")
            .arg("-c")
            .arg(&config_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("无法启动 sing-box：{error}"))?;

        for _ in 0..50 {
            if let Ok(Some(status)) = child.try_wait() {
                let _ = fs::remove_dir_all(&directory);
                return Err(format!("sing-box 启动失败，退出码：{status}"));
            }
            if TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
                return Ok(Self { child, directory, port });
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        let _ = child.kill();
        let _ = child.wait();
        let _ = fs::remove_dir_all(&directory);
        Err("sing-box 启动超时".to_string())
    }

    fn proxy_client(&self, timeout_ms: u64) -> Result<Client, String> {
        let proxy = Proxy::all(format!("http://127.0.0.1:{}", self.port))
            .map_err(|error| format!("无法创建本地代理：{error}"))?;
        Client::builder()
            .proxy(proxy)
            .redirect(Policy::limited(5))
            .timeout(Duration::from_millis(timeout_ms))
            .build()
            .map_err(|error| format!("无法创建测试 HTTP 客户端：{error}"))
    }
}

impl Drop for CoreProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.directory);
    }
}

fn resolve_sing_box(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("sing-box.exe"));
        candidates.push(resource_dir.join("resources").join("sing-box.exe"));
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("sing-box.exe"));
    candidates.push(PathBuf::from("src-tauri").join("resources").join("sing-box.exe"));
    candidates.push(PathBuf::from("resources").join("sing-box.exe"));
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| "找不到 sing-box.exe，请重新构建应用".to_string())
}

async fn tcping(server: &str, port: u16, timeout_ms: u64) -> NodeTestResponse {
    let started = Instant::now();
    match tokio::time::timeout(
        Duration::from_millis(timeout_ms),
        TcpStream::connect((server, port)),
    )
    .await
    {
        Ok(Ok(_)) => NodeTestResponse {
            success: true,
            latency_ms: Some(started.elapsed().as_millis().max(1) as u64),
            ..NodeTestResponse::default()
        },
        Ok(Err(error)) => NodeTestResponse::error(format!("TCP 连接失败：{error}")),
        Err(_) => NodeTestResponse::error(format!("TCP 连接超时（{timeout_ms} ms）")),
    }
}

async fn test_url204(client: &Client, url: &str) -> NodeTestResponse {
    let started = Instant::now();
    match client.get(url).send().await {
        Ok(response) => {
            let status = response.status();
            let latency = started.elapsed().as_millis().max(1) as u64;
            let success = status.is_success() || status.is_redirection();
            NodeTestResponse {
                success,
                latency_ms: Some(latency),
                status_code: Some(status.as_u16()),
                ..NodeTestResponse::default()
            }
        }
        Err(error) => NodeTestResponse::error(format!("204 请求失败：{error}")),
    }
}

async fn test_bandwidth(client: &Client, url: &str, duration_ms: u64) -> NodeTestResponse {
    let duration = Duration::from_millis(duration_ms.max(1_000));
    let warmup = Duration::from_millis(BANDWIDTH_WARMUP_MS.min(duration_ms / 2).max(1));
    let started = Instant::now();
    let measure_at = started + warmup;
    let deadline = measure_at + duration;
    let mut total_bytes = 0u64;

    while Instant::now() < deadline {
        let response = match client.get(url).send().await {
            Ok(response) => response,
            Err(error) => return NodeTestResponse::error(format!("带宽下载失败：{error}")),
        };
        if !response.status().is_success() {
            return NodeTestResponse::error(format!("带宽地址返回 HTTP {}", response.status()));
        }
        let mut response = response;
        while let Some(chunk) = match response.chunk().await {
            Ok(chunk) => chunk,
            Err(error) => return NodeTestResponse::error(format!("带宽读取失败：{error}")),
        } {
            let now = Instant::now();
            if now >= measure_at {
                total_bytes += chunk.len() as u64;
            }
            if now >= deadline {
                break;
            }
        }
    }

    let elapsed = deadline.saturating_duration_since(measure_at).as_secs_f64().max(0.001);
    let mbps = total_bytes as f64 * 8.0 / elapsed / 1_000_000.0;
    NodeTestResponse {
        success: total_bytes > 0,
        download_mbps: Some(mbps),
        error: (total_bytes == 0).then(|| "未收到带宽测试数据".to_string()),
        ..NodeTestResponse::default()
    }
}

fn is_ip(value: &str) -> bool {
    value.parse::<IpAddr>().is_ok()
}

async fn resolve_entries(server: &str, port: u16) -> Vec<String> {
    if is_ip(server) {
        return vec![server.to_string()];
    }
    match tokio::time::timeout(Duration::from_secs(5), tokio::net::lookup_host((server, port))).await {
        Ok(Ok(addresses)) => {
            let mut values: Vec<String> = addresses.map(|address| address.ip().to_string()).collect();
            values.sort();
            values.dedup();
            values
        }
        _ => Vec::new(),
    }
}

fn cdn_provider(ip: IpAddr) -> Option<&'static str> {
    CDN_NETS.iter().find_map(|(provider, cidr)| {
        cidr.parse::<IpNet>().ok().and_then(|network| network.contains(&ip).then_some(*provider))
    })
}

async fn test_link_type(client: &Client, server: &str, port: u16) -> NodeTestResponse {
    let entries = resolve_entries(server, port).await;
    let exit = match client.get(EXIT_IP_URL).send().await {
        Ok(response) => response.text().await.ok().map(|value| value.trim().to_string()).filter(|value| is_ip(value)),
        Err(error) => return NodeTestResponse::error(format!("出口 IP 查询失败：{error}")),
    };
    let Some(exit_ip) = exit else {
        return NodeTestResponse::error("无法获取有效出口 IP");
    };
    let exit_addr = exit_ip.parse::<IpAddr>().ok();
    let entry_addr = entries.iter().filter_map(|value| value.parse::<IpAddr>().ok()).collect::<Vec<_>>();
    let direct = exit_addr.is_some_and(|value| entry_addr.contains(&value));
    let provider = entry_addr.iter().find_map(|ip| cdn_provider(*ip));
    let link_type = if direct {
        "direct"
    } else if provider.is_some() {
        "cdn-relay"
    } else {
        "relay"
    };
    NodeTestResponse {
        success: true,
        link_type: Some(link_type.to_string()),
        entry_ips: entries,
        exit_ip: Some(exit_ip),
        cdn_provider: provider.map(str::to_string),
        ..NodeTestResponse::default()
    }
}

struct UnlockProbe {
    id: &'static str,
    name: &'static str,
    url: &'static str,
    kind: &'static str,
}

const UNLOCK_PROBES: &[UnlockProbe] = &[
    UnlockProbe { id: "google_cn", name: "Google 送中检测", url: "https://www.google.com/generate_204", kind: "google" },
    UnlockProbe { id: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com/", kind: "chatgpt" },
    UnlockProbe { id: "claude", name: "Claude", url: "https://claude.ai/login", kind: "generic" },
    UnlockProbe { id: "gemini", name: "Google Gemini", url: "https://gemini.google.com/", kind: "generic" },
    UnlockProbe { id: "netflix", name: "Netflix", url: "https://www.netflix.com/title/81280792", kind: "netflix" },
    UnlockProbe { id: "disney", name: "Disney+", url: "https://www.disneyplus.com/", kind: "generic" },
    UnlockProbe { id: "max", name: "Max (HBO)", url: "https://auth.max.com/", kind: "generic" },
    UnlockProbe { id: "prime", name: "Prime Video", url: "https://www.primevideo.com/", kind: "generic" },
    UnlockProbe { id: "youtube", name: "YouTube Premium", url: "https://www.youtube.com/premium", kind: "generic" },
    UnlockProbe { id: "tiktok", name: "TikTok", url: "https://www.tiktok.com/", kind: "generic" },
    UnlockProbe { id: "spotify", name: "Spotify", url: "https://www.spotify.com/", kind: "generic" },
    UnlockProbe { id: "wikipedia", name: "Wikipedia", url: "https://en.wikipedia.org/w/api.php?action=query&meta=userinfo&uiprop=blockinfo&format=json", kind: "generic" },
];

fn classify_unlock(probe: &UnlockProbe, status: StatusCode, body: &str, final_url: &str) -> (String, String) {
    let code = status.as_u16();
    if probe.kind == "google" {
        if final_url.contains("google.cn") {
            return ("blocked".to_string(), "请求被重定向到 google.cn".to_string());
        }
        if code == 204 || status.is_success() {
            return ("unlocked".to_string(), "Google 204 连通，未发现送中".to_string());
        }
        return ("warning".to_string(), format!("Google 返回 HTTP {code}"));
    }
    if probe.kind == "chatgpt" {
        let challenge = [403, 429, 451].contains(&code)
            || ["cf-mitigated", "Attention Required", "Just a moment", "Cloudflare Ray ID"]
                .iter()
                .any(|marker| body.contains(marker));
        if challenge {
            return ("blocked".to_string(), format!("ChatGPT 触发地区或风控拦截（HTTP {code}）"));
        }
        if status.is_success() || status.is_redirection() {
            return ("unlocked".to_string(), "ChatGPT 网页端可访问".to_string());
        }
        return ("warning".to_string(), format!("ChatGPT 返回 HTTP {code}"));
    }
    if probe.kind == "netflix" {
        return if status.is_success() {
            ("unlocked".to_string(), "Netflix 标题页可访问".to_string())
        } else if [403, 451].contains(&code) {
            ("blocked".to_string(), format!("Netflix 返回 HTTP {code}"))
        } else {
            ("warning".to_string(), format!("Netflix 返回 HTTP {code}"))
        };
    }
    if status.is_success() || status.is_redirection() {
        ("unlocked".to_string(), format!("服务可访问（HTTP {code}）"))
    } else if [403, 451].contains(&code) {
        ("blocked".to_string(), format!("服务返回 HTTP {code}"))
    } else {
        ("warning".to_string(), format!("服务返回 HTTP {code}"))
    }
}

async fn probe_unlock(client: Client, probe: &'static UnlockProbe) -> UnlockResult {
    match client.get(probe.url).send().await {
        Ok(response) => {
            let status = response.status();
            let final_url = response.url().to_string();
            let body = response.text().await.unwrap_or_default();
            let body = body.chars().take(200_000).collect::<String>();
            let (state, detail) = classify_unlock(probe, status, &body, &final_url);
            UnlockResult {
                id: probe.id.to_string(),
                name: probe.name.to_string(),
                state,
                detail,
                status_code: Some(status.as_u16()),
            }
        }
        Err(error) => UnlockResult {
            id: probe.id.to_string(),
            name: probe.name.to_string(),
            state: "error".to_string(),
            detail: format!("请求失败：{error}"),
            status_code: None,
        },
    }
}

async fn test_unlock(client: &Client) -> NodeTestResponse {
    let mut tasks = JoinSet::new();
    for (index, probe) in UNLOCK_PROBES.iter().enumerate() {
        let client = client.clone();
        tasks.spawn(async move { (index, probe_unlock(client, probe).await) });
    }
    let mut results: Vec<Option<UnlockResult>> = (0..UNLOCK_PROBES.len()).map(|_| None).collect();
    while let Some(result) = tasks.join_next().await {
        match result {
            Ok((index, value)) => results[index] = Some(value),
            Err(error) => return NodeTestResponse::error(format!("解锁检测任务失败：{error}")),
        }
    }
    let unlock = results.into_iter().flatten().collect::<Vec<_>>();
    NodeTestResponse {
        success: !unlock.is_empty(),
        unlock,
        ..NodeTestResponse::default()
    }
}

#[tauri::command]
pub async fn run_node_test(
    app: tauri::AppHandle,
    request: NodeTestRequest,
) -> Result<NodeTestResponse, String> {
    let timeout_ms = request.timeout_ms.unwrap_or(DEFAULT_TEST_TIMEOUT_MS).clamp(1_000, 120_000);
    if request.kind == "tcping" {
        return Ok(tcping(&request.server, request.port, timeout_ms).await);
    }
    if request.outbound.is_none() && request.endpoint.is_none() {
        return Ok(NodeTestResponse::error("当前节点没有可用的 sing-box 配置"));
    }
    let core = CoreProcess::start(&app, request.outbound, request.endpoint).await?;
    let client = core.proxy_client(timeout_ms)?;
    Ok(match request.kind.as_str() {
        "url204" => test_url204(&client, request.url.as_deref().unwrap_or(DEFAULT_204_URL)).await,
        "bandwidth" => test_bandwidth(
            &client,
            request.url.as_deref().unwrap_or(DEFAULT_BANDWIDTH_URL),
            request.duration_ms.unwrap_or(DEFAULT_BANDWIDTH_DURATION_MS),
        ).await,
        "linkType" => test_link_type(&client, &request.server, request.port).await,
        "unlock" => test_unlock(&client).await,
        other => NodeTestResponse::error(format!("未知测试类型：{other}")),
    })
}
