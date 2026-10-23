use percent_encoding::percent_decode_str;
use reqwest::{
    Client, Response, StatusCode,
    header::{ACCEPT, USER_AGENT},
    redirect::Policy,
};
use serde::Serialize;
use std::{io, path::PathBuf, time::Duration};
use url::Url;

const DEFAULT_MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MIN_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_RESPONSE_BYTES_LIMIT: usize = 64 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS: usize = 10;
const MAX_REDIRECTS_LIMIT: usize = 50;
const MAX_OUTPUT_BYTES: usize = 64 * 1024 * 1024;
const MAX_URL_CHARS: usize = 8192;
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
    max_response_bytes: usize,
    max_redirects: usize,
}

impl Default for RequestOptions {
    fn default() -> Self {
        Self {
            skip_certificate_verification: false,
            max_response_bytes: DEFAULT_MAX_RESPONSE_BYTES,
            max_redirects: DEFAULT_MAX_REDIRECTS,
        }
    }
}

impl RequestOptions {
    fn validate(self) -> Result<Self, FetchFailure> {
        if !(MIN_RESPONSE_BYTES..=MAX_RESPONSE_BYTES_LIMIT).contains(&self.max_response_bytes) {
            return Err(FetchFailure::new(
                "invalid_response_limit",
                "响应上限必须在 1 到 64 MiB 之间。",
            ));
        }
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

fn build_client(options: RequestOptions) -> Result<Client, FetchFailure> {
    let max_redirects = options.max_redirects;
    let redirect_policy = Policy::custom(move |attempt| {
        if attempt.previous().len() > max_redirects {
            attempt.error(io::Error::new(io::ErrorKind::InvalidData, "重定向次数过多"))
        } else if !matches!(attempt.url().scheme(), "http" | "https") {
            attempt.error(io::Error::new(
                io::ErrorKind::InvalidData,
                "重定向目标不是 HTTP(S)",
            ))
        } else {
            attempt.follow()
        }
    });

    let mut builder = Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .redirect(redirect_policy);

    if options.skip_certificate_verification {
        builder = builder
            .danger_accept_invalid_certs(true)
            .danger_accept_invalid_hostnames(true);
    }

    builder
        .build()
        .map_err(|_| FetchFailure::new("client_init_failed", "无法初始化本机网络客户端。"))
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

async fn read_limited_response(
    mut response: Response,
    max_response_bytes: usize,
) -> Result<Vec<u8>, FetchFailure> {
    let limit_mib = max_response_bytes / (1024 * 1024);
    if response
        .content_length()
        .is_some_and(|length| length > max_response_bytes as u64)
    {
        return Err(FetchFailure::new(
            "response_too_large",
            format!("订阅响应超过 {limit_mib} MiB 限制。"),
        ));
    }

    let mut body = Vec::with_capacity(
        response
            .content_length()
            .unwrap_or(0)
            .min(max_response_bytes as u64) as usize,
    );
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| network_failure(&error))?
    {
        if body.len().saturating_add(chunk.len()) > max_response_bytes {
            return Err(FetchFailure::new(
                "response_too_large",
                format!("订阅响应超过 {limit_mib} MiB 限制。"),
            ));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn fetch_subscription_inner(
    raw_url: &str,
    custom_user_agent: Option<&str>,
    options: RequestOptions,
) -> Result<FetchedSubscription, FetchFailure> {
    let options = options.validate()?;
    let (url, basic_auth) = parse_target(raw_url)?;
    let agents = user_agents(custom_user_agent)?;
    let client = build_client(options)?;
    let agent_count = agents.len();
    let mut last_status = None;

    for (index, agent) in agents.iter().enumerate() {
        let mut request = client
            .get(url.clone())
            .header(USER_AGENT, agent)
            .header(ACCEPT, "*/*");
        if let Some((username, password)) = &basic_auth {
            request = request.basic_auth(username, Some(password));
        }

        let response = request
            .send()
            .await
            .map_err(|error| network_failure(&error))?;
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
            let body = read_limited_response(response, options.max_response_bytes).await?;

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
    skip_certificate_verification: Option<bool>,
    max_response_bytes: Option<usize>,
    max_redirects: Option<usize>,
) -> Result<FetchedSubscription, FetchFailure> {
    let options = RequestOptions {
        skip_certificate_verification: skip_certificate_verification.unwrap_or(false),
        max_response_bytes: max_response_bytes.unwrap_or(DEFAULT_MAX_RESPONSE_BYTES),
        max_redirects: max_redirects.unwrap_or(DEFAULT_MAX_REDIRECTS),
    };
    fetch_subscription_inner(&url, user_agent.as_deref(), options).await
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
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![fetch_subscription, read_text_file, save_text_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
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
    fn validates_request_limits() {
        let defaults = RequestOptions::default().validate().unwrap();
        assert_eq!(defaults.max_response_bytes, DEFAULT_MAX_RESPONSE_BYTES);
        assert_eq!(defaults.max_redirects, DEFAULT_MAX_REDIRECTS);

        let too_small = RequestOptions {
            max_response_bytes: MIN_RESPONSE_BYTES - 1,
            ..RequestOptions::default()
        }
        .validate()
        .unwrap_err();
        assert_eq!(too_small.code, "invalid_response_limit");

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

    #[tokio::test]
    async fn honors_custom_response_limit() {
        static BODY: [u8; MIN_RESPONSE_BYTES + 1] = [b'a'; MIN_RESPONSE_BYTES + 1];
        let url = serve_once(&BODY, "text/plain").await;
        let failure = fetch_subscription_inner(
            &url,
            Some("TestClient/1.0"),
            RequestOptions {
                max_response_bytes: MIN_RESPONSE_BYTES,
                ..RequestOptions::default()
            },
        )
        .await
        .unwrap_err();
        assert_eq!(failure.code, "response_too_large");
    }

    #[tokio::test]
    async fn rejects_oversized_response() {
        static BODY: [u8; DEFAULT_MAX_RESPONSE_BYTES + 1] = [b'a'; DEFAULT_MAX_RESPONSE_BYTES + 1];
        let url = serve_once(&BODY, "text/plain").await;
        let failure =
            fetch_subscription_inner(&url, Some("TestClient/1.0"), request_options(false))
                .await
                .unwrap_err();
        assert_eq!(failure.code, "response_too_large");
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
