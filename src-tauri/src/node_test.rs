use ipnet::IpNet;
use reqwest::{
    Client, Method, Proxy,
    header::{ACCEPT, ACCEPT_LANGUAGE, LOCATION, SET_COOKIE, USER_AGENT},
    redirect::Policy,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    net::{IpAddr, TcpListener},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use tokio::{net::TcpStream, sync::Semaphore, task::JoinSet};

const DEFAULT_TEST_TIMEOUT_MS: u64 = 10_000;
const DEFAULT_TCPING_TIMEOUT_MS: u64 = 2_000;
const DEFAULT_204_WARMUP_TIMEOUT_MS: u64 = 4_000;
const DEFAULT_204_MEASUREMENT_TIMEOUT_MS: u64 = 1_000;
const DEFAULT_UNLOCK_SERVICE_TIMEOUT_MS: u64 = 3_000;
const DEFAULT_BANDWIDTH_DURATION_MS: u64 = 3_000;
const BANDWIDTH_WARMUP_MS: u64 = 1_000;
const DEFAULT_204_URL: &str = "https://www.google.com/generate_204";
const DEFAULT_204_BACKUP_URL: &str = "https://www.gstatic.com/generate_204";
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
    backup_url: Option<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    warmup_timeout_ms: Option<u64>,
    #[serde(default)]
    measurement_timeout_ms: Option<u64>,
    #[serde(default)]
    duration_ms: Option<u64>,
    #[serde(default)]
    bandwidth_streams: Option<usize>,
    #[serde(default)]
    unlock_service_ids: Option<Vec<String>>,
    #[serde(default)]
    unlock_request_concurrency: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlockResult {
    id: String,
    name: String,
    state: String,
    detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    ip_risk: Option<String>,
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
    latency_min_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    latency_max_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    latency_jitter_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    latency_samples_ms: Vec<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    download_mbps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    download_max_mbps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    download_jitter_mbps: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    download_samples: Vec<BandwidthSample>,
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

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct BandwidthSample {
    duration_ms: u64,
    mbps: f64,
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

async fn probe_url_once(client: &Client, url: &str, timeout_ms: u64) -> Result<(u16, u64), String> {
    let started = Instant::now();
    let response = tokio::time::timeout(
        Duration::from_millis(timeout_ms.max(1)),
        client.get(url).send(),
    )
    .await
    .map_err(|_| format!("请求超时（{timeout_ms} ms）"))?
    .map_err(|error| error.to_string())?;
    Ok((response.status().as_u16(), started.elapsed().as_millis().max(1) as u64))
}

// 连续采集 5 次响应延迟；单次失败不作废其他样本。
async fn probe_url_samples(
    client: &Client,
    url: &str,
    timeout_ms: u64,
) -> Result<(u16, Vec<u64>), String> {
    let mut status = None;
    let mut samples = Vec::with_capacity(5);
    let mut last_error = None;
    for _ in 0..5 {
        match probe_url_once(client, url, timeout_ms).await {
            Ok((sample_status, latency)) => {
                status = Some(sample_status);
                samples.push(latency);
            }
            Err(error) => last_error = Some(error),
        }
    }
    if samples.is_empty() {
        return Err(last_error.unwrap_or_else(|| "没有取得有效延迟样本".to_string()));
    }
    Ok((status.unwrap_or_default(), samples))
}

// 以相邻样本绝对差的均值表示延迟或吞吐量波动。
fn average_absolute_jitter(values: &[f64]) -> Option<f64> {
    if values.len() < 2 {
        return None;
    }
    Some(
        values.windows(2)
            .map(|pair| (pair[1] - pair[0]).abs())
            .sum::<f64>()
            / (values.len() - 1) as f64,
    )
}

async fn test_url204(
    client: &Client,
    primary_url: &str,
    backup_url: Option<&str>,
    warmup_timeout_ms: u64,
    measurement_timeout_ms: u64,
) -> NodeTestResponse {
    let _ = probe_url_once(client, primary_url, warmup_timeout_ms).await;
    let primary = probe_url_samples(client, primary_url, measurement_timeout_ms).await;
    let result = match primary {
        Ok(value) => Ok(value),
        Err(primary_error) => match backup_url.filter(|value| !value.is_empty()) {
            Some(backup) => probe_url_samples(client, backup, measurement_timeout_ms)
                .await
                .map_err(|backup_error| format!("主地址：{primary_error}；备用地址：{backup_error}")),
            None => Err(primary_error),
        },
    };
    match result {
        Ok((status, samples)) => {
            let values = samples.iter().map(|value| *value as f64).collect::<Vec<_>>();
            let average = (values.iter().sum::<f64>() / values.len() as f64).round() as u64;
            NodeTestResponse {
                success: (200..400).contains(&status),
                latency_ms: Some(average),
                latency_min_ms: samples.iter().min().copied(),
                latency_max_ms: samples.iter().max().copied(),
                latency_jitter_ms: average_absolute_jitter(&values),
                latency_samples_ms: samples,
                status_code: Some(status),
                ..NodeTestResponse::default()
            }
        }
        Err(error) => NodeTestResponse::error(format!("204 请求失败：{error}")),
    }
}

async fn download_stream(
    client: Client,
    url: String,
    measure_at: Instant,
    deadline: Instant,
    sample_count: usize,
) -> Result<Vec<u64>, String> {
    let mut samples = vec![0u64; sample_count];
    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let response = match tokio::time::timeout(remaining, client.get(&url).send()).await {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => return Err(format!("下载请求失败：{error}")),
            Err(_) => break,
        };
        if !response.status().is_success() {
            return Err(format!("带宽地址返回 HTTP {}", response.status()));
        }
        let mut response = response;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match tokio::time::timeout(remaining, response.chunk()).await {
                Ok(Ok(Some(chunk))) => {
                    let now = Instant::now();
                    if now >= measure_at && now < deadline {
                        let index = (now.saturating_duration_since(measure_at).as_millis() / 1_000)
                            .min((sample_count - 1) as u128) as usize;
                        samples[index] += chunk.len() as u64;
                    }
                }
                Ok(Ok(None)) => break,
                Ok(Err(error)) => return Err(format!("带宽读取失败：{error}")),
                Err(_) => break,
            }
        }
    }
    Ok(samples)
}

async fn test_bandwidth(
    core: &CoreProcess,
    timeout_ms: u64,
    url: &str,
    duration_ms: u64,
    stream_count: usize,
) -> NodeTestResponse {
    let duration_ms = duration_ms.clamp(1_000, 60_000);
    let duration = Duration::from_millis(duration_ms);
    let warmup = Duration::from_millis(BANDWIDTH_WARMUP_MS);
    let started = Instant::now();
    let measure_at = started + warmup;
    let deadline = measure_at + duration;
    let sample_count = duration_ms.div_ceil(1_000) as usize;
    let mut tasks = JoinSet::new();

    // 每条下载流使用独立客户端连接池，避免多路下载复用同一条 HTTP/2 连接。
    for _ in 0..stream_count.clamp(1, 8) {
        let client = match core.proxy_client(timeout_ms) {
            Ok(client) => client,
            Err(error) => return NodeTestResponse::error(error),
        };
        let url = url.to_string();
        tasks.spawn(async move {
            download_stream(client, url, measure_at, deadline, sample_count).await
        });
    }

    // 预热期间的数据不计入结果；正式窗口按约 1 秒分桶。
    let mut total_samples = vec![0u64; sample_count];
    let mut stream_errors = Vec::new();
    while let Some(result) = tasks.join_next().await {
        match result {
            Ok(Ok(samples)) => {
                for (total, sample) in total_samples.iter_mut().zip(samples) {
                    *total += sample;
                }
            }
            Ok(Err(error)) => stream_errors.push(error),
            Err(error) => stream_errors.push(format!("下载任务失败：{error}")),
        }
    }

    let total_bytes = total_samples.iter().sum::<u64>();
    if total_bytes == 0 {
        let detail = stream_errors.first().cloned().unwrap_or_else(|| "未收到带宽测试数据".to_string());
        return NodeTestResponse::error(detail);
    }

    let samples = total_samples.into_iter().enumerate().map(|(index, bytes)| {
        let sample_duration_ms = duration_ms.saturating_sub(index as u64 * 1_000).min(1_000).max(1);
        let seconds = sample_duration_ms as f64 / 1_000.0;
        BandwidthSample {
            duration_ms: sample_duration_ms,
            mbps: bytes as f64 * 8.0 / seconds / 1_000_000.0,
        }
    }).collect::<Vec<_>>();
    let average_mbps = total_bytes as f64 * 8.0 / (duration_ms as f64 / 1_000.0) / 1_000_000.0;
    let max_mbps = samples.iter().map(|sample| sample.mbps).fold(0.0_f64, f64::max);
    let jitter_mbps = average_absolute_jitter(&samples.iter().map(|sample| sample.mbps).collect::<Vec<_>>());

    NodeTestResponse {
        success: true,
        download_mbps: Some(average_mbps),
        download_max_mbps: Some(max_mbps),
        download_jitter_mbps: jitter_mbps,
        download_samples: samples,
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
}

const UNLOCK_PROBES: &[UnlockProbe] = &[
    UnlockProbe { id: "google_cn", name: "Google 送中检测", url: "https://www.google.com/generate_204" },
    UnlockProbe { id: "chatgpt", name: "ChatGPT / OpenAI", url: "https://chatgpt.com/" },
    UnlockProbe { id: "copilot", name: "Microsoft Copilot", url: "https://copilot.microsoft.com/" },
    UnlockProbe { id: "claude", name: "Claude", url: "https://claude.ai/" },
    UnlockProbe { id: "gemini", name: "Google Gemini", url: "https://gemini.google.com/app" },
    UnlockProbe { id: "llama", name: "Meta Llama API", url: "https://api.llama.com/v1/models" },
    UnlockProbe { id: "perplexity", name: "Perplexity", url: "https://api.perplexity.ai/chat/completions" },
    UnlockProbe { id: "sora", name: "Sora", url: "https://api.openai.com/v1/videos" },
    UnlockProbe { id: "grok", name: "Grok", url: "https://grok.x.ai/" },
    UnlockProbe { id: "netflix", name: "Netflix", url: "https://www.netflix.com/title/81280792" },
    UnlockProbe { id: "disney", name: "Disney+", url: "https://www.disneyplus.com/" },
    UnlockProbe { id: "bilibili", name: "哔哩哔哩港澳台", url: "https://api.bilibili.com/pgc/player/web/playurl?avid=18281381&cid=29892777&qn=0&type=&otype=json&ep_id=183799&fourk=1&fnver=0&fnval=16&module=bangumi" },
    UnlockProbe { id: "dazn", name: "DAZN", url: "https://startup.core.indazn.com/misl/v5/Startup" },
    UnlockProbe { id: "abema", name: "AbemaTV", url: "https://abema.tv/" },
    UnlockProbe { id: "bahamut", name: "巴哈姆特动画疯", url: "https://ani.gamer.com.tw/" },
    UnlockProbe { id: "steam", name: "Steam 商店区", url: "https://store.steampowered.com/app/761830" },
    UnlockProbe { id: "max", name: "Max (HBO)", url: "https://auth.max.com/" },
    UnlockProbe { id: "prime", name: "Prime Video", url: "https://www.primevideo.com/" },
    UnlockProbe { id: "youtube", name: "YouTube Premium", url: "https://www.youtube.com/premium" },
    UnlockProbe { id: "tiktok", name: "TikTok", url: "https://www.tiktok.com/node/share/video/7049860927877885189" },
    UnlockProbe { id: "spotify", name: "Spotify", url: "https://www.spotify.com/signup/" },
    UnlockProbe { id: "wikipedia", name: "Wikipedia", url: "https://en.wikipedia.org/w/api.php?action=query&meta=userinfo&uiprop=blockinfo&format=json" },
];

struct UnlockHttpResponse {
    status_code: u16,
    body: String,
    final_url: String,
    location: Option<String>,
    set_cookies: Vec<String>,
}

const MAX_UNLOCK_BODY_BYTES: usize = 1_000_000;
const UNLOCK_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const UNLOCK_ACCEPT: &str = "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7";

async fn unlock_request(
    client: &Client,
    url: &str,
    method: Method,
    headers: &[(&str, &str)],
    body: Option<&str>,
) -> Result<UnlockHttpResponse, String> {
    let mut request = client
        .request(method, url)
        .header(USER_AGENT, UNLOCK_USER_AGENT)
        .header(ACCEPT, UNLOCK_ACCEPT)
        .header(ACCEPT_LANGUAGE, "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7")
        .header("Cache-Control", "no-cache");
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    if let Some(body) = body {
        request = request.body(body.to_string());
    }

    let mut response = request.send().await.map_err(|error| error.to_string())?;
    let status_code = response.status().as_u16();
    let final_url = response.url().to_string();
    let location = response.headers().get(LOCATION)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let set_cookies = response.headers().get_all(SET_COOKIE).iter()
        .filter_map(|value| value.to_str().ok().map(str::to_string))
        .collect();
    let mut body = Vec::with_capacity(16_384);
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        let remaining = MAX_UNLOCK_BODY_BYTES.saturating_sub(body.len());
        if remaining == 0 {
            break;
        }
        let count = chunk.len().min(remaining);
        body.extend_from_slice(&chunk[..count]);
        if count < chunk.len() {
            break;
        }
    }
    Ok(UnlockHttpResponse {
        status_code,
        body: String::from_utf8_lossy(&body).into_owned(),
        final_url,
        location,
        set_cookies,
    })
}

async fn get_unlock(client: &Client, url: &str) -> Result<UnlockHttpResponse, String> {
    unlock_request(client, url, Method::GET, &[], None).await
}

async fn get_unlock_json(client: &Client, url: &str) -> Result<UnlockHttpResponse, String> {
    unlock_request(client, url, Method::GET, &[("Accept", "application/json")], None).await
}

fn unlock_result(
    probe: &UnlockProbe,
    state: &str,
    detail: impl Into<String>,
    status_code: Option<u16>,
) -> UnlockResult {
    UnlockResult {
        id: probe.id.to_string(),
        name: probe.name.to_string(),
        state: state.to_string(),
        detail: detail.into(),
        ip_risk: None,
        status_code,
    }
}

fn unlock_error(probe: &UnlockProbe, error: impl std::fmt::Display) -> UnlockResult {
    unlock_result(probe, "error", format!("请求失败：{error}"), None)
}

fn contains_any(value: &str, markers: &[&str]) -> bool {
    let value = value.to_ascii_lowercase();
    markers.iter().any(|marker| value.contains(&marker.to_ascii_lowercase()))
}

fn json_string(body: &str, keys: &[&str]) -> Option<String> {
    let value = serde_json::from_str::<Value>(body).ok()?;
    let mut current = &value;
    for key in keys {
        current = current.get(*key)?;
    }
    current.as_str().map(str::to_string)
}

fn jsonish_string(body: &str, key: &str) -> Option<String> {
    let marker = format!("\"{key}\"");
    let after_key = body.get(body.find(&marker)? + marker.len()..)?;
    let after_colon = after_key.get(after_key.find(':')? + 1..)?.trim_start();
    let quoted = after_colon.strip_prefix('"')?;
    Some(quoted.get(..quoted.find('"')?)?.to_string())
}

fn json_bool(body: &str, key: &str) -> Option<bool> {
    serde_json::from_str::<Value>(body).ok()?.get(key)?.as_bool()
}

fn trace_region(body: &str) -> Option<String> {
    body.lines()
        .find_map(|line| line.strip_prefix("loc="))
        .filter(|value| value.len() == 2 && value.bytes().all(|byte| byte.is_ascii_uppercase()))
        .map(str::to_string)
}

fn cookie_header(cookie_groups: &[String]) -> Option<String> {
    let mut cookies = std::collections::BTreeMap::<String, String>::new();
    for header in cookie_groups {
        for cookie in header.split(';').take(1) {
            let pair = cookie.trim();
            if let Some((name, _)) = pair.split_once('=') {
                if !name.trim().is_empty() {
                    cookies.insert(name.trim().to_string(), pair.to_string());
                }
            }
        }
    }
    (!cookies.is_empty()).then(|| cookies.into_values().collect::<Vec<_>>().join("; "))
}

// 按服务的 HTTP 状态和响应内容区分支持、部分可用、受限与待确认。
fn classify_unlock(probe: &UnlockProbe, response: &UnlockHttpResponse) -> UnlockResult {
    let code = response.status_code;
    let body = response.body.to_ascii_lowercase();
    let reachable = (200..400).contains(&code);
    let region = || trace_region(&response.body).map(|value| format!("；出口地区 {value}")).unwrap_or_default();
    match probe.id {
        "google_cn" => {
            if response.final_url.to_ascii_lowercase().contains("google.cn")
                || response.location.as_deref().is_some_and(|value| value.to_ascii_lowercase().contains("google.cn"))
            {
                unlock_result(probe, "blocked", "Google 请求被重定向到 google.cn", Some(code))
            } else if code == 204 || (200..300).contains(&code) {
                unlock_result(probe, "unlocked", "Google 端点可访问，未发现送中", Some(code))
            } else {
                unlock_result(probe, "warning", format!("Google 返回 HTTP {code}，无法确认地区状态"), Some(code))
            }
        }
        "copilot" => {
            let blocked = contains_any(&body, &["not available in your region", "unavailable in your market"]);
            if blocked || code != 200 {
                unlock_result(probe, "blocked", format!("Copilot 返回地区限制信号或 HTTP {code}"), Some(code))
            } else {
                unlock_result(probe, "unlocked", "Copilot 网页端可访问", Some(code))
            }
        }
        "claude" => {
            if contains_any(&body, &["not available in your country"]) || code != 200 {
                unlock_result(probe, "blocked", format!("Claude 返回地区限制信号或 HTTP {code}"), Some(code))
            } else {
                unlock_result(probe, "unlocked", format!("Claude 网页端可访问{}", region()), Some(code))
            }
        }
        "gemini" => {
            if code >= 400 || contains_any(&body, &["isn't currently supported in your country", "not available in your country"]) {
                unlock_result(probe, "blocked", format!("Gemini 返回地区限制信号或 HTTP {code}"), Some(code))
            } else if reachable {
                unlock_result(probe, "unlocked", format!("Gemini 网页端可访问{}", region()), Some(code))
            } else {
                unlock_result(probe, "warning", format!("Gemini 返回 HTTP {code}"), Some(code))
            }
        }
        "llama" | "perplexity" | "sora" => {
            if contains_any(&body, &["unsupported_country", "not available in your country", "not supported in your region"]) {
                unlock_result(probe, "blocked", format!("服务响应包含地区限制信号（HTTP {code}）"), Some(code))
            } else if code == 200 || code == 401 {
                unlock_result(probe, "unlocked", format!("API 端点可达（HTTP {code}，未验证账号或 API 密钥）{}", region()), Some(code))
            } else {
                unlock_result(probe, "warning", format!("API 返回 HTTP {code}，无法确认地区权限"), Some(code))
            }
        }
        "grok" => {
            if contains_any(&body, &["not available in your country", "unsupported_country"]) {
                unlock_result(probe, "blocked", "Grok 响应包含地区限制提示", Some(code))
            } else if code == 200 {
                unlock_result(probe, "unlocked", "Grok 网页端可访问", Some(code))
            } else {
                unlock_result(probe, "blocked", format!("Grok 返回 HTTP {code}"), Some(code))
            }
        }
        "netflix" => {
            if contains_any(&body, &["oh no!"]) || !reachable {
                unlock_result(probe, "blocked", format!("Netflix 标题页不可用（HTTP {code}）"), Some(code))
            } else {
                let region = json_string(&response.body, &["requestCountry", "id"])
                    .or_else(|| jsonish_string(&response.body, "geolocation_country"))
                    .unwrap_or_default();
                let suffix = if region.is_empty() { String::new() } else { format!("；地区 {region}") };
                unlock_result(probe, "unlocked", format!("Netflix 非自制内容可访问{suffix}"), Some(code))
            }
        }
        "disney" => {
            if code >= 400
                || contains_any(&body, &["not available in your region"])
                || response.final_url.to_ascii_lowercase().contains("blocked")
                || response.location.as_deref().is_some_and(|value| contains_any(value, &["blocked", "unavailable"]))
            {
                unlock_result(probe, "blocked", format!("Disney+ 返回地区限制信号或 HTTP {code}"), Some(code))
            } else {
                unlock_result(probe, "unlocked", "Disney+ 入口可访问", Some(code))
            }
        }
        "bilibili" => {
            let api_code = serde_json::from_str::<Value>(&response.body).ok().and_then(|value| value.get("code")?.as_i64());
            match (code, api_code) {
                (200, Some(0)) => unlock_result(probe, "unlocked", "哔哩哔哩港澳台番剧可播放", Some(code)),
                (200, Some(api_code)) => {
                    let message = json_string(&response.body, &["message"]).unwrap_or_default();
                    unlock_result(probe, "blocked", format!("港澳台番剧受限（API {api_code}）{message}"), Some(code))
                }
                _ => unlock_result(probe, "warning", format!("哔哩哔哩播放接口返回 HTTP {code} 或无效 JSON"), Some(code)),
            }
        }
        "dazn" => {
            let denied = serde_json::from_str::<Value>(&response.body).ok()
                .and_then(|value| value.get("isAllowed").and_then(Value::as_bool))
                .is_some_and(|value| !value);
            let country = ["geoLocatedCountry", "country", "region"].iter()
                .find_map(|key| json_string(&response.body, &[*key]));
            if code != 200 || denied {
                unlock_result(probe, "blocked", format!("DAZN 拒绝访问或返回 isAllowed=false（HTTP {code}）"), Some(code))
            } else if let Some(country) = country {
                unlock_result(probe, "unlocked", format!("DAZN 允许当前地区 {country}"), Some(code))
            } else {
                unlock_result(probe, "warning", "DAZN 接口可达，但没有可识别的地区字段", Some(code))
            }
        }
        "abema" => {
            if code == 200 {
                unlock_result(probe, "unlocked", "AbemaTV 日本区入口可访问", Some(code))
            } else {
                unlock_result(probe, "blocked", format!("AbemaTV 返回 HTTP {code}"), Some(code))
            }
        }
        "bahamut" => {
            if code == 200 && body.contains("animesn") {
                unlock_result(probe, "unlocked", "巴哈姆特动画播放令牌可用", Some(code))
            } else {
                unlock_result(probe, "blocked", format!("动画疯设备或播放令牌不可用（HTTP {code}）"), Some(code))
            }
        }
        "steam" => {
            let currency = response.body.split("itemprop=\"priceCurrency\"").nth(1)
                .and_then(|value| value.split("content=\"").nth(1))
                .and_then(|value| value.split('"').next());
            if code == 200 {
                if let Some(currency) = currency {
                    unlock_result(probe, "unlocked", format!("Steam 商店可访问，货币 {currency}"), Some(code))
                } else {
                    unlock_result(probe, "warning", "Steam 商店可访问，但没有识别到货币代码", Some(code))
                }
            } else {
                unlock_result(probe, "blocked", format!("Steam 商店返回 HTTP {code}"), Some(code))
            }
        }
        "max" | "prime" => {
            let blocked_markers = if probe.id == "max" {
                &["not available in your region", "unsupported_location"][..]
            } else {
                &["georestricted", "not-available-in-your-country", "not available in your location"][..]
            };
            let success_markers = if probe.id == "max" {
                &["max", "hbo", "sign in", "login"][..]
            } else {
                &["prime video", "primevideo", "amazon"][..]
            };
            if [403, 451].contains(&code) || contains_any(&body, blocked_markers) {
                unlock_result(probe, "blocked", format!("{} 返回地区限制信号", probe.name), Some(code))
            } else if reachable && contains_any(&body, success_markers) {
                unlock_result(probe, "unlocked", format!("{} 页面可访问，未发现地区限制", probe.name), Some(code))
            } else if reachable {
                unlock_result(probe, "warning", format!("{} 可连接，但无法确认地区授权", probe.name), Some(code))
            } else {
                unlock_result(probe, "blocked", format!("{} 返回 HTTP {code}", probe.name), Some(code))
            }
        }
        "youtube" => {
            let region = jsonish_string(&response.body, "gl")
                .or_else(|| response.final_url.split("gl=").nth(1).map(|value| value.chars().take(2).collect()));
            if code != 200 {
                unlock_result(probe, "blocked", format!("YouTube Premium 页面返回 HTTP {code}"), Some(code))
            } else if region.as_deref().is_none_or(|value| value.eq_ignore_ascii_case("CN")) {
                unlock_result(probe, "blocked", "YouTube 地区码为空或为 CN", Some(code))
            } else {
                unlock_result(probe, "unlocked", format!("YouTube Premium 开放地区 {}", region.unwrap_or_default()), Some(code))
            }
        }
        "tiktok" => {
            let region = jsonish_string(&response.body, "region");
            if code == 200 && region.is_some() {
                unlock_result(probe, "unlocked", format!("TikTok 分享接口可用，地区 {}", region.unwrap_or_default()), Some(code))
            } else {
                unlock_result(probe, "blocked", format!("TikTok 分享接口没有返回地区信息（HTTP {code}）"), Some(code))
            }
        }
        "spotify" => {
            if code == 200 && !contains_any(&body, &["not available in your country", "spotify is currently not available"]) {
                unlock_result(probe, "unlocked", "Spotify 注册页可访问", Some(code))
            } else {
                unlock_result(probe, "blocked", format!("Spotify 返回地区限制信号或 HTTP {code}"), Some(code))
            }
        }
        "wikipedia" => {
            if code == 403 {
                unlock_result(probe, "blocked", "Wikipedia API 返回 403", Some(code))
            } else if contains_any(&body, &["\"blockid\"", "\"blockedby\""]) {
                unlock_result(probe, "partial", "Wikipedia 可访问，但匿名编辑受限", Some(code))
            } else if reachable && contains_any(&body, &["\"userinfo\"", "\"id\":0", "\"anon\""]) {
                unlock_result(probe, "unlocked", "Wikipedia API 可访问，未发现匿名编辑封禁", Some(code))
            } else {
                unlock_result(probe, "blocked", format!("Wikipedia API 返回 HTTP {code}，访问受限"), Some(code))
            }
        }
        _ if reachable => unlock_result(probe, "unlocked", format!("服务可访问（HTTP {code}）"), Some(code)),
        _ if [403, 451].contains(&code) => unlock_result(probe, "blocked", format!("服务返回 HTTP {code}"), Some(code)),
        _ => unlock_result(probe, "warning", format!("服务返回 HTTP {code}，无法确认地区状态"), Some(code)),
    }
}

async fn probe_unlock(client: Client, probe: &'static UnlockProbe) -> UnlockResult {
    let result: Result<UnlockResult, String> = async {
        match probe.id {
        "chatgpt" => {
            // 同时检查 ChatGPT 网页风控、OpenAI 地区合规接口和 IP 风控接口。
            let web = get_unlock(&client, probe.url).await;
            let compliance = unlock_request(
                &client,
                "https://api.openai.com/compliance/cookie_requirements",
                Method::GET,
                &[
                    ("Authorization", "Bearer null"),
                    ("Content-Type", "application/json"),
                    ("Origin", "https://platform.openai.com"),
                    ("Referer", "https://platform.openai.com/"),
                    ("Accept", "application/json"),
                ],
                None,
            ).await;
            let ios = get_unlock(&client, "https://ios.chat.openai.com/").await;
            match (web, compliance, ios) {
                (Ok(web), Ok(compliance), Ok(ios)) => {
                    let country_blocked = contains_any(&compliance.body, &["unsupported_country"]);
                    let vpn_flag = json_bool(&ios.body, "vpn");
                    let vpn_blocked = vpn_flag.unwrap_or(false)
                        || ios.body.to_ascii_lowercase().contains("\"vpn\":true");
                    let ip_risk = if vpn_blocked {
                        Some("high".to_string())
                    } else {
                        vpn_flag.map(|_| "low".to_string())
                    };
                    let challenge = [403, 429, 451].contains(&web.status_code)
                        || contains_any(&web.body, &["cf-mitigated", "attention required", "error code: 1020", "just a moment", "cloudflare ray id"]);
                    let mobile_available = (200..300).contains(&ios.status_code)
                        && contains_any(&ios.body, &["status", "ok", "normal", "maintenance"]);
                    let web_available = (200..400).contains(&web.status_code) && !challenge;
                    let state = if country_blocked || vpn_blocked || (!web_available && !mobile_available) {
                        "blocked"
                    } else if !web_available && mobile_available {
                        "partial"
                    } else {
                        "unlocked"
                    };
                    let detail = if country_blocked && vpn_blocked {
                        "OpenAI 地区接口与 IP 风控接口均返回限制信号"
                    } else if country_blocked {
                        "OpenAI 接口返回 unsupported_country"
                    } else if vpn_blocked {
                        "OpenAI iOS 接口将出口 IP 识别为 VPN 或代理"
                    } else if state == "partial" {
                        "网页端触发验证，但 OpenAI App/API 状态接口可访问"
                    } else if challenge {
                        "ChatGPT 网页端触发 Cloudflare 或风控验证"
                    } else {
                        "ChatGPT 网页端可访问，OpenAI 地区与 IP 检查未返回限制信号"
                    };
                    let mut result = unlock_result(probe, state, detail, Some(web.status_code));
                    result.ip_risk = ip_risk;
                    Ok(result)
                }
                (Err(error), _, _) | (_, Err(error), _) | (_, _, Err(error)) => Err(error),
            }
        }
        "claude" => {
            let page = get_unlock(&client, probe.url).await?;
            let trace = get_unlock(&client, "https://claude.ai/cdn-cgi/trace").await.ok();
            let mut result = classify_unlock(probe, &page);
            if result.state == "unlocked" {
                if let Some(region) = trace.as_ref().and_then(|value| trace_region(&value.body)) {
                    result.detail.push_str(&format!("；出口地区 {region}"));
                }
            }
            Ok(result)
        }
        "perplexity" => {
            let api = unlock_request(
                &client,
                probe.url,
                Method::POST,
                &[("Content-Type", "application/json"), ("Accept", "application/json")],
                Some("{}"),
            ).await?;
            let trace = get_unlock(&client, "https://www.perplexity.ai/cdn-cgi/trace").await.ok();
            let mut result = classify_unlock(probe, &api);
            if result.state == "unlocked" {
                if let Some(region) = trace.as_ref().and_then(|value| trace_region(&value.body)) {
                    result.detail.push_str(&format!("；出口地区 {region}"));
                }
            }
            Ok(result)
        }
        "sora" => {
            let api = get_unlock_json(&client, probe.url).await?;
            let trace = get_unlock(&client, "https://chat.openai.com/cdn-cgi/trace").await.ok();
            let mut result = classify_unlock(probe, &api);
            if result.state == "unlocked" {
                if let Some(region) = trace.as_ref().and_then(|value| trace_region(&value.body)) {
                    result.detail.push_str(&format!("；出口地区 {region}"));
                }
            }
            Ok(result)
        }
        "llama" | "bilibili" | "wikipedia" => {
            let url = if probe.id == "bilibili" {
                let session = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos();
                format!("{}&session={session}", probe.url)
            } else {
                probe.url.to_string()
            };
            get_unlock_json(&client, &url).await.map(|response| classify_unlock(probe, &response))
        }
        "netflix" => {
            // 非自制标题与自制标题分别探测，用于区分完整可用和仅自制内容可用。
            let licensed = get_unlock(&client, probe.url).await?;
            let original = get_unlock(&client, "https://www.netflix.com/title/80057281").await.ok();
            let licensed_unavailable = contains_any(&licensed.body, &["oh no!"]) || !(200..400).contains(&licensed.status_code);
            let original_unavailable = original.as_ref().is_none_or(|value| {
                contains_any(&value.body, &["oh no!"]) || !(200..400).contains(&value.status_code)
            });
            let region = json_string(&licensed.body, &["requestCountry", "id"])
                .or_else(|| jsonish_string(&licensed.body, "geolocation_country"));
            let result = if !licensed_unavailable {
                let suffix = region.map(|value| format!("；地区 {value}")).unwrap_or_default();
                unlock_result(probe, "unlocked", format!("Netflix 非自制内容可访问{suffix}"), Some(licensed.status_code))
            } else if !original_unavailable {
                unlock_result(probe, "partial", "仅支持 Netflix 自制内容，非自制版权内容受限", original.as_ref().map(|value| value.status_code))
            } else {
                unlock_result(probe, "blocked", "Netflix 自制及非自制标题均不可用", Some(licensed.status_code))
            };
            Ok(result)
        }
        "dazn" => {
            let response = unlock_request(
                &client,
                probe.url,
                Method::POST,
                &[("Content-Type", "application/json"), ("Accept", "application/json")],
                Some(r#"{"LandingPageKey":"generic","Languages":"en","Platform":"web","Version":"2"}"#),
            ).await?;
            Ok(classify_unlock(probe, &response))
        }
        "bahamut" => {
            // 按设备 ID、播放令牌和页面 Cookie 顺序验证动画播放授权。
            let device = get_unlock(&client, "https://ani.gamer.com.tw/ajax/getdeviceid.php").await?;
            let device_id = json_string(&device.body, &["deviceid"]);
            let Some(device_id) = device_id.filter(|value| !value.is_empty()) else {
                return Ok(unlock_result(probe, "blocked", "動畫瘋設備接口沒有返回 deviceid", Some(device.status_code)));
            };
            let device_cookie = cookie_header(&device.set_cookies);
            let encoded_device = url::form_urlencoded::byte_serialize(device_id.as_bytes()).collect::<String>();
            let token_headers = device_cookie.as_deref().map(|cookie| vec![("Cookie", cookie)]).unwrap_or_default();
            let token = unlock_request(
                &client,
                &format!("https://ani.gamer.com.tw/ajax/token.php?adID=89422&sn=37783&device={encoded_device}"),
                Method::GET,
                &token_headers,
                None,
            ).await?;
            if !token.body.to_ascii_lowercase().contains("animesn") {
                return Ok(unlock_result(probe, "blocked", "動畫瘋令牌接口沒有返回 animeSn", Some(token.status_code)));
            }
            let home_cookie = cookie_header(&[device.set_cookies.clone(), token.set_cookies.clone()].concat());
            let home_headers = home_cookie.as_deref().map(|cookie| vec![("Cookie", cookie)]).unwrap_or_default();
            let home = unlock_request(&client, probe.url, Method::GET, &home_headers, None).await.ok();
            let region = home.as_ref().and_then(|response| {
                let marker = "data-geo=\"";
                let start = response.body.to_ascii_lowercase().find(marker)? + marker.len();
                let rest = response.body.get(start..)?;
                Some(rest.get(..rest.find('"')?)?.to_string())
            }).filter(|value| !value.is_empty()).unwrap_or_else(|| "TW".to_string());
            Ok(unlock_result(probe, "unlocked", format!("巴哈姆特动画播放令牌可用；地区 {region}"), Some(token.status_code)))
        }
        _ => get_unlock(&client, probe.url).await.map(|response| classify_unlock(probe, &response)),
        }
    }.await;

    result.unwrap_or_else(|error| unlock_error(probe, error))
}

async fn test_unlock(
    client: &Client,
    service_ids: Option<&[String]>,
    request_concurrency: usize,
) -> NodeTestResponse {
    let probes: Vec<&'static UnlockProbe> = UNLOCK_PROBES
        .iter()
        .filter(|probe| service_ids.is_none_or(|ids| ids.is_empty() || ids.iter().any(|id| id == probe.id)))
        .collect();
    if probes.is_empty() {
        return NodeTestResponse::error("未选择任何解锁检测服务");
    }
    let permits = Arc::new(Semaphore::new(request_concurrency.clamp(1, probes.len())));
    let mut tasks = JoinSet::new();
    for (index, probe) in probes.iter().copied().enumerate() {
        let client = client.clone();
        let permits = permits.clone();
        tasks.spawn(async move {
            let _permit = permits.acquire_owned().await;
            (index, probe_unlock(client, probe).await)
        });
    }
    let mut results: Vec<Option<UnlockResult>> = (0..probes.len()).map(|_| None).collect();
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
    // 缺少前端参数时，后端回退值也与设置页默认值保持一致。
    let default_timeout_ms = match request.kind.as_str() {
        "tcping" => DEFAULT_TCPING_TIMEOUT_MS,
        "url204" => DEFAULT_204_MEASUREMENT_TIMEOUT_MS,
        "unlock" => DEFAULT_UNLOCK_SERVICE_TIMEOUT_MS,
        _ => DEFAULT_TEST_TIMEOUT_MS,
    };
    let timeout_ms = request.timeout_ms.unwrap_or(default_timeout_ms).clamp(1_000, 120_000);
    if request.kind == "tcping" {
        return Ok(tcping(&request.server, request.port, timeout_ms).await);
    }
    if request.outbound.is_none() && request.endpoint.is_none() {
        return Ok(NodeTestResponse::error("当前节点没有可用的 sing-box 配置"));
    }
    let warmup_timeout_ms = request.warmup_timeout_ms.unwrap_or_else(|| {
        if request.kind == "url204" { DEFAULT_204_WARMUP_TIMEOUT_MS } else { timeout_ms }
    }).clamp(1_000, 120_000);
    let measurement_timeout_ms = request.measurement_timeout_ms.unwrap_or_else(|| {
        if request.kind == "url204" { DEFAULT_204_MEASUREMENT_TIMEOUT_MS } else { timeout_ms }
    }).clamp(1_000, 120_000);
    let bandwidth_duration_ms = request.duration_ms.unwrap_or(DEFAULT_BANDWIDTH_DURATION_MS).clamp(1_000, 60_000);
    let client_timeout_ms = if request.kind == "bandwidth" {
        timeout_ms.max(bandwidth_duration_ms + BANDWIDTH_WARMUP_MS + 5_000)
    } else {
        timeout_ms.max(warmup_timeout_ms).max(measurement_timeout_ms)
    };
    let core = CoreProcess::start(&app, request.outbound, request.endpoint).await?;
    let client = core.proxy_client(client_timeout_ms)?;
    Ok(match request.kind.as_str() {
        "url204" => test_url204(
            &client,
            request.url.as_deref().unwrap_or(DEFAULT_204_URL),
            Some(request.backup_url.as_deref().unwrap_or(DEFAULT_204_BACKUP_URL)),
            warmup_timeout_ms,
            measurement_timeout_ms,
        ).await,
        "bandwidth" => test_bandwidth(
            &core,
            client_timeout_ms,
            request.url.as_deref().unwrap_or(DEFAULT_BANDWIDTH_URL),
            bandwidth_duration_ms,
            request.bandwidth_streams.unwrap_or(4),
        ).await,
        "linkType" => test_link_type(&client, &request.server, request.port).await,
        "unlock" => test_unlock(
            &client,
            request.unlock_service_ids.as_deref(),
            request.unlock_request_concurrency.unwrap_or(4),
        ).await,
        other => NodeTestResponse::error(format!("未知测试类型：{other}")),
    })
}
