use percent_encoding::percent_decode_str;
use reqwest::{
    Client, Response, StatusCode,
    header::{ACCEPT, USER_AGENT},
    redirect::Policy,
};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    future::Future,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::net::lookup_host;
use tokio::sync::Notify;
use url::Url;

mod region_lookup;

const DEFAULT_MAX_REDIRECTS: usize = 10;
const MAX_REDIRECTS_LIMIT: usize = 50;
const MAX_OUTPUT_BYTES: usize = 64 * 1024 * 1024;
const MAX_URL_CHARS: usize = 8192;
const MAX_COMPLETED_REQUEST_IDS: usize = 2048;
const MAX_PENDING_REQUEST_IDS: usize = 4096;
const DEFAULT_USER_AGENTS: &[&str] = &[
    "NekoBox/Android/1.4.2 (Prefer ClashMeta Format)",
    "sing-box/1.15.0",
    "clash-meta/1.19.0",
    "v2rayN/7.8.2",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FetchedSubscription {
    content: String,
    final_url: String,
    content_type: Option<String>,
    subscription_user_info: Option<String>,
    bytes: usize,
    used_user_agent: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FetchFailure {
    code: String,
    message: String,
    status: Option<u16>,
}

#[derive(Debug, Clone, Copy)]
struct RequestOptions {
    skip_certificate_verification: bool,
    allow_local_network: bool,
    max_redirects: usize,
}

#[derive(Default)]
struct FetchCancellation {
    cancelled: AtomicBool,
    notify: Notify,
}

impl FetchCancellation {
    fn cancel(&self) {
        if !self.cancelled.swap(true, Ordering::AcqRel) {
            self.notify.notify_one();
        }
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    async fn cancelled(&self) {
        loop {
            let notified = self.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

#[derive(Default)]
struct FetchCancellationRegistry {
    state: Mutex<FetchCancellationState>,
}

#[derive(Default)]
struct FetchCancellationState {
    active: HashMap<String, Arc<FetchCancellation>>,
    pending: HashSet<String>,
    completed: HashSet<String>,
    completed_order: VecDeque<String>,
}

impl FetchCancellationRegistry {
    fn register(&self, request_id: &str) -> Result<Arc<FetchCancellation>, FetchFailure> {
        if request_id.trim().is_empty() {
            return Err(FetchFailure::new("invalid_request_id", "取消请求缺少有效的请求 ID。"));
        }
        let mut state = self.state.lock().map_err(|_| {
            FetchFailure::new("cancellation_unavailable", "无法初始化请求取消状态。")
        })?;
        if state.active.contains_key(request_id) {
            return Err(FetchFailure::new("duplicate_request_id", "请求 ID 已在使用中。"));
        }
        let cancellation = Arc::new(FetchCancellation::default());
        let was_cancelled = state.pending.remove(request_id);
        if was_cancelled {
            cancellation.cancel();
        }
        state.completed.remove(request_id);
        state.completed_order.retain(|id| id != request_id);
        state.active.insert(request_id.to_string(), cancellation.clone());
        Ok(cancellation)
    }

    fn cancel(&self, request_id: &str) -> bool {
        let Ok(mut state) = self.state.lock() else { return false };
        let active = state.active.get(request_id).cloned();
        if let Some(cancellation) = active {
            cancellation.cancel();
            return true;
        }
        if state.completed.contains(request_id) || state.pending.len() >= MAX_PENDING_REQUEST_IDS {
            return false;
        }
        state.pending.insert(request_id.to_string())
    }

    fn unregister(&self, request_id: &str, cancellation: &Arc<FetchCancellation>) {
        if let Ok(mut state) = self.state.lock() {
            if state.active.get(request_id).is_some_and(|current| Arc::ptr_eq(current, cancellation)) {
                state.active.remove(request_id);
            }
            state.pending.remove(request_id);
            if state.completed.insert(request_id.to_string()) {
                state.completed_order.push_back(request_id.to_string());
            }
            while state.completed_order.len() > MAX_COMPLETED_REQUEST_IDS {
                if let Some(expired) = state.completed_order.pop_front() {
                    state.completed.remove(&expired);
                }
            }
        }
    }
}

async fn cancellable<T>(
    cancellation: &FetchCancellation,
    future: impl Future<Output = T>,
) -> Result<T, FetchFailure> {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(FetchFailure::new("cancelled", "订阅请求已取消。")),
        value = future => Ok(value),
    }
}

impl Default for RequestOptions {
    fn default() -> Self {
        Self {
            skip_certificate_verification: false,
            allow_local_network: false,
            max_redirects: DEFAULT_MAX_REDIRECTS,
        }
    }
}

impl RequestOptions {
    fn validate(self) -> Result<Self, FetchFailure> {
        if self.max_redirects > MAX_REDIRECTS_LIMIT {
            return Err(FetchFailure::new(
                "invalid_redirect_limit",
                "最大重定向次数不能超过 50。",
            ));
        }
        Ok(self)
    }
}

impl FetchFailure {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            status: None,
        }
    }

    fn with_status(
        code: impl Into<String>,
        message: impl Into<String>,
        status: StatusCode,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            status: Some(status.as_u16()),
        }
    }
}

fn parse_target(input: &str) -> Result<(Url, Option<(String, String)>), FetchFailure> {
    let value = input.trim();
    if value.is_empty() {
        return Err(FetchFailure::new("invalid_url", "订阅 URL 不能为空。"));
    }
    if value.chars().count() > MAX_URL_CHARS || value.contains(['\r', '\n']) {
        return Err(FetchFailure::new(
            "invalid_url",
            "订阅 URL 过长或包含换行。",
        ));
    }

    let mut url =
        Url::parse(value).map_err(|_| FetchFailure::new("invalid_url", "订阅 URL 格式无效。"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(FetchFailure::new(
            "unsupported_scheme",
            "仅支持 HTTP 或 HTTPS 订阅地址。",
        ));
    }
    if url.host_str().is_none() {
        return Err(FetchFailure::new("invalid_url", "订阅 URL 缺少主机名。"));
    }

    // URL 中的 userinfo 只转换为 Basic Auth，不保留在请求地址和返回信息中。
    let username = percent_decode_str(url.username())
        .decode_utf8_lossy()
        .into_owned();
    let password = url
        .password()
        .map(|value| percent_decode_str(value).decode_utf8_lossy().into_owned());
    let auth = if username.is_empty() {
        None
    } else {
        Some((username, password.unwrap_or_default()))
    };

    url.set_username("")
        .map_err(|_| FetchFailure::new("invalid_url", "无法清理订阅 URL 中的账号信息。"))?;
    url.set_password(None)
        .map_err(|_| FetchFailure::new("invalid_url", "无法清理订阅 URL 中的密码信息。"))?;
    url.set_fragment(None);
    Ok((url, auth))
}

fn user_agents(custom: Option<&str>) -> Result<Vec<String>, FetchFailure> {
    let Some(custom) = custom.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(DEFAULT_USER_AGENTS
            .iter()
            .map(|value| (*value).to_string())
            .collect());
    };
    if custom.chars().count() > 512 || custom.chars().any(char::is_control) {
        return Err(FetchFailure::new(
            "invalid_user_agent",
            "User-Agent 格式无效。",
        ));
    }
    Ok(vec![custom.to_string()])
}

fn is_special_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_unspecified()
        || ip.is_multicast()
        || a == 0
        || (a == 100 && (64..=127).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 88 && c == 99)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 240
}

fn is_special_ipv6(ip: Ipv6Addr) -> bool {
    if let Some(ipv4) = ip.to_ipv4_mapped() {
        return is_special_ipv4(ipv4);
    }
    let segments = ip.segments();
    let global_unicast = segments[0] & 0xe000 == 0x2000;
    !global_unicast
        || ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_unique_local()
        || ip.is_unicast_link_local()
        || ip.is_multicast()
        || (segments[0] == 0x2001 && segments[1] == 0x0db8)
        || (segments[0] == 0x2001 && segments[1] == 0x0000)
        || (segments[0] == 0x2001 && segments[1] == 0x0002 && segments[2] == 0)
        || (segments[0] == 0x2001 && segments[1] & 0xfff0 == 0x0010)
        || (segments[0] == 0x2001 && segments[1] & 0xfff0 == 0x0020)
        || segments[0] == 0x2002
        || (segments[0] == 0x3fff && segments[1] & 0xf000 == 0)
}

fn is_special_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(value) => is_special_ipv4(value),
        IpAddr::V6(value) => is_special_ipv6(value),
    }
}

fn is_local_name(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    ["localhost", ".localhost", ".local", ".lan", ".internal", ".home.arpa"]
        .iter()
        .any(|suffix| host == *suffix || host.ends_with(suffix))
}

async fn resolve_target_addresses(url: &Url, allow_local_network: bool) -> Result<Vec<SocketAddr>, FetchFailure> {
    let host = url
        .host_str()
        .ok_or_else(|| FetchFailure::new("invalid_url", "订阅 URL 缺少主机名。"))?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| FetchFailure::new("invalid_url", "订阅 URL 缺少有效端口。"))?;
    if !allow_local_network && is_local_name(host) {
        return Err(FetchFailure::new(
            "local_network_blocked",
            "订阅地址指向本机或本地域名；请在输入设置中明确允许本机及局域网访问。",
        ));
    }

    // 每个跳转目标都重新解析并检查；后续请求固定到已检查的地址，避免 DNS 重绑定。
    let addresses = if let Ok(ip) = host.parse::<IpAddr>() {
        vec![SocketAddr::new(ip, port)]
    } else {
        lookup_host((host, port))
            .await
            .map_err(|_| FetchFailure::new("dns_failed", "无法解析订阅服务器地址。"))?
            .collect::<Vec<_>>()
    };
    if addresses.is_empty() {
        return Err(FetchFailure::new("dns_failed", "订阅服务器没有可用的网络地址。"));
    }
    if !allow_local_network && addresses.iter().any(|address| is_special_ip(address.ip())) {
        return Err(FetchFailure::new(
            "local_network_blocked",
            "订阅服务器解析到本机、内网或特殊用途地址；请确认来源可信后允许本机及局域网访问。",
        ));
    }
    Ok(addresses)
}

fn build_client(options: RequestOptions, url: &Url, addresses: &[SocketAddr]) -> Result<Client, FetchFailure> {
    let mut builder = Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .redirect(Policy::none());

    if let Some(domain) = url.domain() {
        builder = builder.resolve_to_addrs(domain, addresses);
    }

    if options.skip_certificate_verification {
        builder = builder
            .danger_accept_invalid_certs(true)
            .danger_accept_invalid_hostnames(true);
    }

    builder
        .build()
        .map_err(|_| FetchFailure::new("client_init_failed", "无法初始化本机网络客户端。"))
}

async fn send_with_redirects(
    start_url: &Url,
    basic_auth: Option<&(String, String)>,
    user_agent: &str,
    options: RequestOptions,
    cancellation: &FetchCancellation,
) -> Result<Response, FetchFailure> {
    // 手动跟随跳转，以便逐跳重做网络策略检查，并只向同源目标转发 Basic Auth。
    let mut url = start_url.clone();
    for redirects in 0..=options.max_redirects {
        let addresses = cancellable(
            cancellation,
            tokio::time::timeout(
                Duration::from_secs(10),
                resolve_target_addresses(&url, options.allow_local_network),
            ),
        )
        .await?
        .map_err(|_| FetchFailure::new("dns_timeout", "解析订阅服务器地址超时。"))??;
        let client = build_client(options, &url, &addresses)?;
        let mut request = client
            .get(url.clone())
            .header(USER_AGENT, user_agent)
            .header(ACCEPT, "*/*");
        if url.origin() == start_url.origin() {
            if let Some((username, password)) = basic_auth {
                request = request.basic_auth(username, Some(password));
            }
        }
        let response = cancellable(cancellation, request.send()).await?
            .map_err(|error| network_failure(&error))?;
        let status = response.status();
        if !matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308) {
            return Ok(response);
        }
        if redirects >= options.max_redirects {
            return Err(FetchFailure::new("redirect_failed", "订阅地址重定向次数超过限制。"));
        }
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| FetchFailure::new("redirect_failed", "订阅服务器的重定向地址无效。"))?;
        let next = response
            .url()
            .join(location)
            .map_err(|_| FetchFailure::new("redirect_failed", "订阅服务器的重定向地址无效。"))?;
        if !matches!(next.scheme(), "http" | "https") {
            return Err(FetchFailure::new("redirect_failed", "重定向目标不是 HTTP(S)。"));
        }
        url = next;
    }
    Err(FetchFailure::new("redirect_failed", "订阅地址重定向次数超过限制。"))
}

fn sanitized_display_url(url: &Url) -> String {
    let mut value = url.clone();
    let _ = value.set_username("");
    let _ = value.set_password(None);
    value.set_fragment(None);
    value.to_string()
}

fn network_failure(error: &reqwest::Error) -> FetchFailure {
    if error.is_timeout() {
        FetchFailure::new("timeout", "订阅请求超时，请检查网络或稍后重试。")
    } else if error.is_connect() {
        FetchFailure::new("connect_failed", "无法连接订阅服务器，请检查地址和网络。")
    } else if error.is_redirect() {
        FetchFailure::new("redirect_failed", "订阅地址重定向失败或次数超过限制。")
    } else {
        FetchFailure::new("network_error", "订阅请求失败，请检查网络连接。")
    }
}

fn http_failure(status: StatusCode) -> FetchFailure {
    let message = match status.as_u16() {
        401 => "订阅服务器要求认证，请检查 URL 中的账号密码。",
        403 => "订阅服务器拒绝访问（HTTP 403）。",
        404 => "订阅地址不存在（HTTP 404）。",
        429 => "订阅服务器请求过于频繁（HTTP 429），请稍后重试。",
        500..=599 => "订阅服务器暂时不可用，请稍后重试。",
        _ => "订阅服务器返回了非成功状态。",
    };
    FetchFailure::with_status("http_error", message, status)
}

fn should_retry_with_next_user_agent(status: StatusCode) -> bool {
    matches!(status.as_u16(), 400 | 403 | 406 | 415)
}

async fn read_response(
    mut response: Response,
    cancellation: &FetchCancellation,
) -> Result<Vec<u8>, FetchFailure> {
    let mut body = Vec::new();
    loop {
        let chunk = cancellable(cancellation, response.chunk()).await?
            .map_err(|error| network_failure(&error))?;
        let Some(chunk) = chunk else { break };
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

#[cfg(test)]
async fn fetch_subscription_inner(
    raw_url: &str,
    custom_user_agent: Option<&str>,
    options: RequestOptions,
) -> Result<FetchedSubscription, FetchFailure> {
    let cancellation = FetchCancellation::default();
    fetch_subscription_inner_cancellable(raw_url, custom_user_agent, options, &cancellation).await
}

async fn fetch_subscription_inner_cancellable(
    raw_url: &str,
    custom_user_agent: Option<&str>,
    options: RequestOptions,
    cancellation: &FetchCancellation,
) -> Result<FetchedSubscription, FetchFailure> {
    let options = options.validate()?;
    let (url, basic_auth) = parse_target(raw_url)?;
    let agents = user_agents(custom_user_agent)?;
    let agent_count = agents.len();
    let mut last_status = None;

    for (index, agent) in agents.iter().enumerate() {
        let response = send_with_redirects(&url, basic_auth.as_ref(), agent, options, cancellation).await?;
        let status = response.status();
        last_status = Some(status);

        if status.is_success() {
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            let subscription_user_info = response
                .headers()
                .get("subscription-userinfo")
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            let final_url = sanitized_display_url(response.url());
            let body = read_response(response, cancellation).await?;

            if body.is_empty() {
                if index + 1 < agent_count {
                    continue;
                }
                return Err(FetchFailure::new(
                    "empty_response",
                    "订阅服务器返回了空内容。",
                ));
            }

            let content = String::from_utf8_lossy(&body)
                .trim_start_matches('\u{feff}')
                .to_string();
            return Ok(FetchedSubscription {
                content,
                final_url,
                content_type,
                subscription_user_info,
                bytes: body.len(),
                used_user_agent: agent.clone(),
            });
        }

        if index + 1 < agent_count && should_retry_with_next_user_agent(status) {
            continue;
        }
        return Err(http_failure(status));
    }

    Err(match last_status {
        Some(status) => http_failure(status),
        None => FetchFailure::new("network_error", "订阅请求失败，请稍后重试。"),
    })
}
#[tauri::command]
async fn fetch_subscription(
    url: String,
    user_agent: Option<String>,
    request_id: Option<String>,
    skip_certificate_verification: Option<bool>,
    allow_local_network: Option<bool>,
    max_redirects: Option<usize>,
    cancellations: tauri::State<'_, FetchCancellationRegistry>,
) -> Result<FetchedSubscription, FetchFailure> {
    let options = RequestOptions {
        skip_certificate_verification: skip_certificate_verification.unwrap_or(false),
        allow_local_network: allow_local_network.unwrap_or(false),
        max_redirects: max_redirects.unwrap_or(DEFAULT_MAX_REDIRECTS),
    };
    let registered = request_id
        .as_deref()
        .map(|request_id| cancellations.register(request_id).map(|token| (request_id.to_string(), token)))
        .transpose()?;
    let fallback = Arc::new(FetchCancellation::default());
    let token = registered.as_ref().map(|(_, token)| token).unwrap_or(&fallback);
    let result = fetch_subscription_inner_cancellable(&url, user_agent.as_deref(), options, token).await;
    if let (Some(request_id), Some((_, token))) = (request_id.as_deref(), registered.as_ref()) {
        cancellations.unregister(request_id, token);
    }
    result
}

#[tauri::command]
fn cancel_subscription(
    request_id: String,
    cancellations: tauri::State<'_, FetchCancellationRegistry>,
) -> bool {
    cancellations.cancel(&request_id)
}

#[tauri::command]
fn save_text_file(path: String, content: String) -> Result<String, FetchFailure> {
    if content.len() > MAX_OUTPUT_BYTES {
        return Err(FetchFailure::new(
            "output_too_large",
            "输出内容超过 64 MiB，无法保存。",
        ));
    }

    let target = PathBuf::from(path.trim());
    if !target.is_absolute() {
        return Err(FetchFailure::new(
            "invalid_path",
            "保存路径必须是绝对路径。",
        ));
    }
    let is_txt = target
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("txt"));
    if !is_txt {
        return Err(FetchFailure::new(
            "invalid_path",
            "仅支持保存为 .txt 文件。",
        ));
    }

    std::fs::write(&target, content)
        .map_err(|_| FetchFailure::new("write_failed", "写入文件失败，请检查保存位置。"))?;
    Ok(target.to_string_lossy().into_owned())
}

/// 读取用户主动选择的 UTF-8 文本文件，限制大小并去除 BOM。
#[tauri::command]
fn read_text_file(path: String) -> Result<String, FetchFailure> {
    let target = PathBuf::from(path.trim());
    if !target.is_absolute() {
        return Err(FetchFailure::new(
            "invalid_path",
            "文件路径必须是绝对路径。",
        ));
    }
    let metadata = std::fs::metadata(&target)
        .map_err(|_| FetchFailure::new("read_failed", "无法读取文件，请检查路径和权限。"))?;
    if !metadata.is_file() {
        return Err(FetchFailure::new("invalid_path", "选择的路径不是文件。"));
    }
    if metadata.len() > MAX_OUTPUT_BYTES as u64 {
        return Err(FetchFailure::new(
            "input_too_large",
            "输入文件超过 64 MiB，无法读取。",
        ));
    }
    let bytes = std::fs::read(&target)
        .map_err(|_| FetchFailure::new("read_failed", "无法读取文件，请检查路径和权限。"))?;
    let content = String::from_utf8(bytes)
        .map_err(|_| FetchFailure::new("invalid_encoding", "文件不是有效的 UTF-8 文本。"))?;
    Ok(content.trim_start_matches('\u{feff}').to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(FetchCancellationRegistry::default())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            fetch_subscription,
            cancel_subscription,
            read_text_file,
            save_text_file,
            region_lookup::lookup_node_regions,
            region_lookup::lookup_cloudflare_entries
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        sync::oneshot,
    };

    async fn serve_once(body: &'static [u8], content_type: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0_u8; 4096];
            let _ = socket.read(&mut buffer).await;
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(header.as_bytes()).await.unwrap();
            socket.write_all(body).await.unwrap();
        });
        format!("http://{address}/subscription")
    }

    fn request_options(skip_certificate_verification: bool) -> RequestOptions {
        RequestOptions {
            skip_certificate_verification,
            allow_local_network: true,
            ..RequestOptions::default()
        }
    }

    async fn serve_redirects(redirects: usize, body: &'static [u8]) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            for index in 0..=redirects {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buffer = [0_u8; 4096];
                let _ = socket.read(&mut buffer).await;
                let response = if index < redirects {
                    "HTTP/1.1 302 Found\r\nLocation: /subscription\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string()
                } else {
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    )
                };
                socket.write_all(response.as_bytes()).await.unwrap();
                if index == redirects {
                    socket.write_all(body).await.unwrap();
                }
            }
        });
        format!("http://{address}/subscription")
    }

    async fn serve_once_tls(body: &'static [u8], content_type: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let rcgen::CertifiedKey { cert, signing_key } =
            rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
        let key_der =
            tokio_rustls::rustls::pki_types::PrivatePkcs8KeyDer::from(signing_key.serialize_der());
        let config = tokio_rustls::rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(vec![cert.der().clone()], key_der.into())
            .unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(std::sync::Arc::new(config));

        tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = acceptor.accept(socket).await.unwrap();
            let mut buffer = [0_u8; 4096];
            let _ = socket.read(&mut buffer).await;
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(header.as_bytes()).await.unwrap();
            socket.write_all(body).await.unwrap();
        });

        format!("https://localhost:{}/subscription", address.port())
    }

    #[test]
    fn parses_basic_auth_without_keeping_credentials_in_url() {
        let (url, auth) =
            parse_target("https://user%40name:p%40ss@example.com/sub?token=abc").unwrap();
        assert_eq!(url.as_str(), "https://example.com/sub?token=abc");
        assert_eq!(auth, Some(("user@name".to_string(), "p@ss".to_string())));
    }

    #[test]
    fn blocks_local_and_special_network_targets_by_default() {
        assert!(is_special_ip("127.0.0.1".parse().unwrap()));
        assert!(is_special_ip("10.0.0.1".parse().unwrap()));
        assert!(is_special_ip("169.254.1.2".parse().unwrap()));
        assert!(is_special_ip("::1".parse().unwrap()));
        assert!(is_special_ip("::ffff:192.168.1.1".parse().unwrap()));
        assert!(is_special_ip("2001:db8::1".parse().unwrap()));
        assert!(is_special_ip("2002:c000:0201::1".parse().unwrap()));
        assert!(!is_special_ip("1.1.1.1".parse().unwrap()));
        assert!(!is_special_ip("2606:4700:4700::1111".parse().unwrap()));
        assert!(is_local_name("printer.local."));
        assert!(is_local_name("host.home.arpa"));
        assert!(!is_local_name("example.com"));
    }

    #[tokio::test]
    async fn rejects_local_addresses_unless_explicitly_allowed() {
        let url = Url::parse("http://127.0.0.1:8080/subscription").unwrap();
        let failure = resolve_target_addresses(&url, false).await.unwrap_err();
        assert_eq!(failure.code, "local_network_blocked");
        assert_eq!(resolve_target_addresses(&url, true).await.unwrap().len(), 1);

        let local_name = Url::parse("http://printer.local/subscription").unwrap();
        let failure = resolve_target_addresses(&local_name, false).await.unwrap_err();
        assert_eq!(failure.code, "local_network_blocked");
    }

    #[test]
    fn cancellation_registry_handles_early_and_late_cancel_messages() {
        let registry = FetchCancellationRegistry::default();
        assert!(registry.cancel("request-1"));
        let token = registry.register("request-1").unwrap();
        assert!(token.is_cancelled());
        registry.unregister("request-1", &token);
        assert!(!registry.cancel("request-1"));
    }

    #[test]
    fn cancellation_registry_resolves_register_race() {
        for _ in 0..100 {
            let registry = Arc::new(FetchCancellationRegistry::default());
            let barrier = Arc::new(std::sync::Barrier::new(3));
            let register_registry = registry.clone();
            let register_barrier = barrier.clone();
            let register = std::thread::spawn(move || {
                register_barrier.wait();
                register_registry.register("racing-request").unwrap()
            });
            let cancel_registry = registry.clone();
            let cancel_barrier = barrier.clone();
            let cancel = std::thread::spawn(move || {
                cancel_barrier.wait();
                cancel_registry.cancel("racing-request")
            });
            barrier.wait();
            let token = register.join().unwrap();
            assert!(cancel.join().unwrap());
            assert!(token.is_cancelled());
            registry.unregister("racing-request", &token);
        }
    }

    #[tokio::test]
    async fn cancels_an_in_flight_subscription_request() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (accepted_tx, accepted_rx) = oneshot::channel();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0_u8; 4096];
            let _ = socket.read(&mut buffer).await;
            let _ = accepted_tx.send(());
            std::future::pending::<()>().await;
        });

        let cancellation = Arc::new(FetchCancellation::default());
        let task_cancellation = cancellation.clone();
        let url = format!("http://{address}/subscription");
        let request = tokio::spawn(async move {
            fetch_subscription_inner_cancellable(
                &url,
                Some("TestClient/1.0"),
                request_options(false),
                &task_cancellation,
            )
            .await
        });
        accepted_rx.await.unwrap();
        cancellation.cancel();
        let failure = request.await.unwrap().unwrap_err();
        assert_eq!(failure.code, "cancelled");
    }

    #[tokio::test]
    async fn rejects_self_signed_certificate_by_default() {
        let url = serve_once_tls(b"vless://node@example.com:443", "text/plain").await;
        let result =
            fetch_subscription_inner(&url, Some("TestClient/1.0"), request_options(false)).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn allows_self_signed_certificate_when_verification_is_skipped() {
        let url = serve_once_tls(b"vless://node@example.com:443", "text/plain").await;
        let result = fetch_subscription_inner(&url, Some("TestClient/1.0"), request_options(true))
            .await
            .unwrap();
        assert_eq!(result.content, "vless://node@example.com:443");
    }

    #[test]
    fn validates_request_options() {
        let defaults = RequestOptions::default().validate().unwrap();
        assert_eq!(defaults.max_redirects, DEFAULT_MAX_REDIRECTS);

        let too_many_redirects = RequestOptions {
            max_redirects: MAX_REDIRECTS_LIMIT + 1,
            ..RequestOptions::default()
        }
        .validate()
        .unwrap_err();
        assert_eq!(too_many_redirects.code, "invalid_redirect_limit");
    }

    #[tokio::test]
    async fn honors_configured_redirect_limit() {
        let url = serve_redirects(1, b"vless://node@example.com:443").await;
        let failure = fetch_subscription_inner(
            &url,
            Some("TestClient/1.0"),
            RequestOptions {
                max_redirects: 0,
                allow_local_network: true,
                ..RequestOptions::default()
            },
        )
        .await
        .unwrap_err();
        assert_eq!(failure.code, "redirect_failed");

        let url = serve_redirects(1, b"vless://node@example.com:443").await;
        let result = fetch_subscription_inner(
            &url,
            Some("TestClient/1.0"),
            RequestOptions {
                max_redirects: 1,
                allow_local_network: true,
                ..RequestOptions::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(result.content, "vless://node@example.com:443");
    }

    #[test]
    fn rejects_non_http_schemes() {
        let failure = parse_target("file:///C:/secret.txt").unwrap_err();
        assert_eq!(failure.code, "unsupported_scheme");
    }

    #[tokio::test]
    async fn fetches_plain_text_subscription() {
        let url = serve_once(b"vless://node@example.com:443", "text/plain").await;
        let result = fetch_subscription_inner(&url, Some("TestClient/1.0"), request_options(false))
            .await
            .unwrap();
        assert_eq!(result.content, "vless://node@example.com:443");
        assert_eq!(result.used_user_agent, "TestClient/1.0");
        assert_eq!(result.bytes, 28);
    }

    #[test]
    fn only_saves_txt_files() {
        let target = std::env::temp_dir().join(format!(
            "chimera-subscription-test-{}.bin",
            std::process::id()
        ));
        let failure =
            save_text_file(target.to_string_lossy().into_owned(), "test".to_string()).unwrap_err();
        assert_eq!(failure.code, "invalid_path");
    }

    #[test]
    fn saves_utf8_txt_file() {
        let target = std::env::temp_dir().join(format!(
            "chimera-subscription-test-{}.txt",
            std::process::id()
        ));
        let path = target.to_string_lossy().into_owned();
        save_text_file(path.clone(), "vless://测试节点".to_string()).unwrap();
        assert_eq!(
            std::fs::read_to_string(std::path::Path::new(&path)).unwrap(),
            "vless://测试节点"
        );
        let _ = std::fs::remove_file(target);
    }

    #[test]
    fn reads_utf8_text_file_and_strips_bom() {
        let target = std::env::temp_dir().join(format!(
            "chimera-subscription-read-test-{}.yaml",
            std::process::id()
        ));
        std::fs::write(&target, "\u{feff}vless://node@example.com:443").unwrap();
        let content = read_text_file(target.to_string_lossy().into_owned()).unwrap();
        assert_eq!(content, "vless://node@example.com:443");
        let _ = std::fs::remove_file(target);
    }
}
