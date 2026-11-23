//! Process-wide HTTP plumbing shared by Host features and the headless CLI:
//! proxy configuration, client factories, the product User-Agent, and
//! error-body truncation.

use crate::error::AppError;
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, Instant};

/// Product User-Agent sent by Host HTTP clients by default.
///
/// The repo + mailto contacts keep Crossref / Semantic Scholar requests in
/// their polite pools.
pub const USER_AGENT: &str = concat!(
    "Agentero/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/nonsense-j/Agentero; mailto:agentero@users.noreply.github.com)"
);

/// Browser-like UA for endpoints that reject non-browser agents with HTTP 403
/// (PLOS / IEEE / Springer publisher PDFs, free web-MT endpoints). Use only
/// where a browser is deliberately impersonated; prefer [`USER_AGENT`]
/// everywhere else.
pub const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/// Redirect cap applied by [`client`] (reqwest's own default is 10).
pub const DEFAULT_REDIRECT_LIMIT: usize = 5;

/// How many chars of an HTTP error body [`http_err_snippet`] keeps.
const ERROR_SNIPPET_CHARS: usize = 180;

static PROXY_URL: OnceLock<RwLock<Option<String>>> = OnceLock::new();
static SHARED_CLIENT: OnceLock<RwLock<Option<CachedClient>>> = OnceLock::new();
/// Cached GitHub token discovered from environment variables or `gh auth token`.
/// The token is never logged and is only attached to direct `api.github.com`
/// requests.
static GITHUB_AUTH_TOKEN: OnceLock<RwLock<CachedGithubToken>> = OnceLock::new();
/// (last detected OS system proxy, when it was checked). `None` timestamp =
/// never checked.
static SYSTEM_PROXY: OnceLock<RwLock<(Option<String>, Option<Instant>)>> = OnceLock::new();

/// The OS-level proxy can be toggled at runtime (Clash / V2RayN "system
/// proxy" mode); re-read it at most this often.
const SYSTEM_PROXY_TTL: Duration = Duration::from_secs(30);
const GITHUB_AUTH_TOKEN_TTL: Duration = Duration::from_secs(300);

struct CachedClient {
    proxy: Option<String>,
    client: reqwest::Client,
}

#[derive(Default)]
struct CachedGithubToken {
    token: Option<String>,
    checked_at: Option<Instant>,
}

fn proxy_slot() -> &'static RwLock<Option<String>> {
    PROXY_URL.get_or_init(|| RwLock::new(None))
}

/// Configure the proxy used by every Host-created reqwest client.
pub fn configure_proxy(enabled: bool, url: &str) -> Result<(), AppError> {
    let normalized = url.trim().to_string();
    let next = if enabled {
        if normalized.is_empty() {
            return Err(AppError::message("network proxy URL is required"));
        }
        reqwest::Proxy::all(&normalized)
            .map_err(|e| AppError::message(format!("invalid network proxy URL: {e}")))?;
        Some(normalized)
    } else {
        None
    };

    let mut guard = proxy_slot()
        .write()
        .map_err(|_| AppError::message("network proxy lock poisoned"))?;
    *guard = next;
    drop(guard);
    if let Some(slot) = SHARED_CLIENT.get() {
        if let Ok(mut cached) = slot.write() {
            *cached = None;
        }
    }
    if let Some(slot) = SYSTEM_PROXY.get() {
        if let Ok(mut cached) = slot.write() {
            *cached = (None, None);
        }
    }
    Ok(())
}

fn cached_slot() -> &'static RwLock<Option<CachedClient>> {
    SHARED_CLIENT.get_or_init(|| RwLock::new(None))
}

fn parse_env_proxy_value(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized = with_proxy_scheme(trimmed, "http");
    reqwest::Proxy::all(&normalized).ok()?;
    Some(normalized)
}

fn env_proxy_url() -> Option<String> {
    for key in [
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        if let Ok(val) = std::env::var(key) {
            if let Some(parsed) = parse_env_proxy_value(&val) {
                return Some(parsed);
            }
        }
    }
    None
}

#[cfg(windows)]
fn windows_wininet_proxy_url() -> Option<String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu
        .open_subkey_with_flags(
            r"Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            KEY_READ,
        )
        .ok()?;
    let enabled: u32 = key.get_value("ProxyEnable").ok()?;
    if enabled == 0 {
        return None;
    }
    let server: String = key.get_value("ProxyServer").ok()?;
    parse_windows_proxy_server(&server)
}

#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
fn parse_macos_scutil_proxy(output: &str) -> Option<String> {
    let mut http_enabled = false;
    let mut http_host: Option<&str> = None;
    let mut http_port: Option<&str> = None;
    let mut https_enabled = false;
    let mut https_host: Option<&str> = None;
    let mut https_port: Option<&str> = None;
    let mut socks_enabled = false;
    let mut socks_host: Option<&str> = None;
    let mut socks_port: Option<&str> = None;

    for line in output.lines() {
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        let k = k.trim();
        let v = v.trim();
        if v.is_empty() {
            continue;
        }
        match k {
            "HTTPEnable" => http_enabled = v == "1",
            "HTTPProxy" => http_host = Some(v),
            "HTTPPort" => http_port = Some(v),
            "HTTPSEnable" => https_enabled = v == "1",
            "HTTPSProxy" => https_host = Some(v),
            "HTTPSPort" => https_port = Some(v),
            "SOCKSEnable" => socks_enabled = v == "1",
            "SOCKSProxy" => socks_host = Some(v),
            "SOCKSPort" => socks_port = Some(v),
            _ => {}
        }
    }

    let format_host_port = |scheme: &str, host: &str, port: Option<&str>| -> Option<String> {
        let addr = match port.filter(|p| !p.is_empty() && *p != "0") {
            Some(p) => format!("{host}:{p}"),
            None => host.to_string(),
        };
        let url = with_proxy_scheme(&addr, scheme);
        reqwest::Proxy::all(&url).ok()?;
        Some(url)
    };

    if http_enabled {
        if let Some(h) = http_host {
            if let Some(url) = format_host_port("http", h, http_port) {
                return Some(url);
            }
        }
    }
    if https_enabled {
        if let Some(h) = https_host {
            if let Some(url) = format_host_port("http", h, https_port) {
                return Some(url);
            }
        }
    }
    if socks_enabled {
        if let Some(h) = socks_host {
            if let Some(url) = format_host_port("socks5h", h, socks_port) {
                return Some(url);
            }
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn macos_scutil_proxy_url() -> Option<String> {
    let output = std::process::Command::new("scutil")
        .arg("--proxy")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    parse_macos_scutil_proxy(&text)
}

/// The OS / environment proxy selected by Agentero's fallback policy.
///
/// Reqwest 0.12 also offers native discovery through `system-proxy`, but its
/// matcher does not expose the selected URL for settings or child processes.
/// Keep this small adapter for those consumers and our dynamic TTL; delegate
/// URL validation and HTTP routing to `reqwest::Proxy::all`.
pub fn system_proxy_url() -> Option<String> {
    #[cfg(windows)]
    {
        windows_wininet_proxy_url().or_else(env_proxy_url)
    }
    #[cfg(target_os = "macos")]
    {
        macos_scutil_proxy_url().or_else(env_proxy_url)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        env_proxy_url()
    }
}

/// Parse the Windows `ProxyServer` registry value: either a bare `host:port`
/// or `http=host:port;https=host:port;socks=host:port`.
// Only called from the Windows branch + unit tests; keep it compiled (and
// tested) on every platform.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn parse_windows_proxy_server(server: &str) -> Option<String> {
    let trimmed = server.trim();
    if trimmed.is_empty() {
        return None;
    }
    if !trimmed.contains('=') {
        return Some(with_proxy_scheme(trimmed, "http"));
    }
    let mut http = None;
    let mut https = None;
    let mut socks = None;
    for part in trimmed.split(';') {
        let Some((kind, value)) = part.split_once('=') else {
            continue;
        };
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        match kind.trim().to_ascii_lowercase().as_str() {
            "http" => http = Some(value),
            "https" => https = Some(value),
            "socks" => socks = Some(value),
            _ => {}
        }
    }
    // The `http=`/`https=` keys name which traffic a proxy serves, not how the
    // proxy itself is reached — the proxy is contacted over plain HTTP (HTTPS
    // targets tunnel via CONNECT). So both map to an `http://` proxy URL;
    // returning `https://` would make reqwest TLS-handshake with a plain HTTP
    // proxy and fail. Prefer the `http=` entry, then `https=`.
    http.or(https)
        .map(|v| with_proxy_scheme(v, "http"))
        .or_else(|| socks.map(|v| with_proxy_scheme(v, "socks5h")))
}

#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn with_proxy_scheme(value: &str, default_scheme: &str) -> String {
    if value.contains("://") {
        value.to_string()
    } else {
        format!("{default_scheme}://{value}")
    }
}

/// TTL-cached [`system_proxy_url`] so request paths only touch the registry
/// every [`SYSTEM_PROXY_TTL`].
fn system_proxy_cached() -> Option<String> {
    let slot = SYSTEM_PROXY.get_or_init(|| RwLock::new((None, None)));
    if let Ok(guard) = slot.read() {
        if guard.1.is_some_and(|t| t.elapsed() < SYSTEM_PROXY_TTL) {
            return guard.0.clone();
        }
    }
    let detected = system_proxy_url();
    if let Ok(mut guard) = slot.write() {
        *guard = (detected.clone(), Some(Instant::now()));
    }
    detected
}

/// The proxy every Host-created client should use: the explicit setting when
/// enabled, otherwise the detected system proxy. Also the value forwarded to
/// Host-spawned subprocesses so in-app and CLI network behavior match.
pub fn effective_proxy_url() -> Option<String> {
    if let Ok(guard) = proxy_slot().read() {
        if guard.is_some() {
            return guard.clone();
        }
    }
    system_proxy_cached()
}

/// A process-wide reqwest client so TLS sessions and HTTP keep-alive survive
/// across plaza / Cool Papers requests. Rebuilt when the effective proxy
/// changes (explicit setting or detected system proxy).
pub fn shared_client() -> Result<reqwest::Client, AppError> {
    let proxy = effective_proxy_url();
    {
        let guard = cached_slot()
            .read()
            .map_err(|_| AppError::message("network client lock poisoned"))?;
        if let Some(cached) = guard.as_ref() {
            if cached.proxy == proxy {
                return Ok(cached.client.clone());
            }
        }
    }
    // Build from the same snapshot used as the cache key. A settings change
    // between two effective_proxy_url calls must not label a new client with
    // the previous proxy.
    let client = client_builder_with_proxy(proxy.as_deref())
        .pool_idle_timeout(Duration::from_secs(90))
        .pool_max_idle_per_host(8)
        .redirect(reqwest::redirect::Policy::limited(DEFAULT_REDIRECT_LIMIT))
        .build()
        .map_err(|e| AppError::message(format!("http client: {e}")))?;
    let mut guard = cached_slot()
        .write()
        .map_err(|_| AppError::message("network client lock poisoned"))?;
    if let Some(cached) = guard.as_ref() {
        if cached.proxy == proxy {
            return Ok(cached.client.clone());
        }
    }
    *guard = Some(CachedClient {
        proxy,
        client: client.clone(),
    });
    Ok(client)
}

/// Build a reqwest client builder with the current process-wide proxy.
///
/// Prefer [`client`] / [`client_with`]; reach for this directly only when a
/// flow must deviate from their defaults (e.g. no timeout at all).
pub fn client_builder() -> reqwest::ClientBuilder {
    let proxy = effective_proxy_url();
    client_builder_with_proxy(proxy.as_deref())
}

fn client_builder_with_proxy(proxy: Option<&str>) -> reqwest::ClientBuilder {
    let builder = reqwest::Client::builder();
    match proxy {
        Some(url) => match reqwest::Proxy::all(url) {
            Ok(proxy) => builder.proxy(proxy.no_proxy(loopback_bypass())),
            Err(error) => {
                log::error!(target: "agentero::network", "invalid configured proxy: {error}");
                builder
            }
        },
        None => builder,
    }
}

/// Loopback destinations never go through the proxy: a self-hosted service on
/// this machine (MinerU behind an SSH tunnel, Ollama) is unreachable through a
/// proxy in global mode, and the OS system proxy bypasses them too.
fn loopback_bypass() -> Option<reqwest::NoProxy> {
    reqwest::NoProxy::from_string("localhost,127.0.0.0/8,::1")
}

/// Standard Host HTTP client: [`USER_AGENT`], the configured proxy, `timeout`,
/// and at most [`DEFAULT_REDIRECT_LIMIT`] redirects.
pub fn client(timeout: Duration) -> Result<reqwest::Client, AppError> {
    client_with(timeout, DEFAULT_REDIRECT_LIMIT, USER_AGENT)
}

/// [`client`] with an explicit redirect cap and User-Agent — for deeper
/// redirect chains (model / asset downloads) or browser impersonation
/// ([`BROWSER_USER_AGENT`]).
pub fn client_with(
    timeout: Duration,
    redirect_limit: usize,
    user_agent: &str,
) -> Result<reqwest::Client, AppError> {
    client_builder()
        .timeout(timeout)
        .user_agent(user_agent)
        .redirect(reqwest::redirect::Policy::limited(redirect_limit))
        .build()
        .map_err(|e| AppError::message(format!("http client: {e}")))
}

/// First [`ERROR_SNIPPET_CHARS`] chars of an HTTP response body, for embedding
/// in error messages.
pub fn http_err_snippet(text: &str) -> String {
    text.chars().take(ERROR_SNIPPET_CHARS).collect()
}

/// Add the local GitHub CLI / env token to direct GitHub REST API requests.
pub fn with_github_api_auth(
    request: reqwest::RequestBuilder,
    url: &str,
) -> reqwest::RequestBuilder {
    if !is_direct_github_api_url(url) {
        return request;
    }
    match github_auth_token() {
        Some(token) => request.bearer_auth(token),
        None => request,
    }
}

fn is_direct_github_api_url(url: &str) -> bool {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .as_deref()
        == Some("api.github.com")
}

fn github_auth_token() -> Option<String> {
    let slot = GITHUB_AUTH_TOKEN.get_or_init(|| RwLock::new(CachedGithubToken::default()));
    if let Ok(guard) = slot.read() {
        if guard
            .checked_at
            .is_some_and(|t| t.elapsed() < GITHUB_AUTH_TOKEN_TTL)
        {
            return guard.token.clone();
        }
    }

    let token = discover_github_auth_token();
    if let Ok(mut guard) = slot.write() {
        *guard = CachedGithubToken {
            token: token.clone(),
            checked_at: Some(Instant::now()),
        };
    }
    token
}

fn discover_github_auth_token() -> Option<String> {
    for key in ["GH_TOKEN", "GITHUB_TOKEN"] {
        if let Ok(token) = std::env::var(key) {
            let token = token.trim();
            if !token.is_empty() {
                return Some(token.to_string());
            }
        }
    }

    let gh = crate::process::resolve_command("gh")?;
    let mut command = std::process::Command::new(gh);
    command.args(["auth", "token", "--hostname", "github.com"]);
    crate::process::hide_console_window(&mut command);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let token = String::from_utf8(output.stdout).ok()?;
    let token = token.trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #866: a loopback service answers even when the proxy is unreachable.
    #[tokio::test]
    async fn loopback_requests_bypass_the_proxy() {
        use std::io::{Read, Write};
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = server.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = server.accept() {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok");
            }
        });
        // A proxy port nothing listens on: any proxied request fails.
        let dead = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let proxy = format!("http://{}", dead.local_addr().unwrap());
        drop(dead);
        let client = client_builder_with_proxy(Some(&proxy))
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let body = client
            .get(format!("http://127.0.0.1:{port}/v1/health"))
            .send()
            .await
            .expect("loopback request should not use the proxy")
            .text()
            .await
            .unwrap();
        assert_eq!(body, "ok");
    }

    #[test]
    fn accepts_supported_proxy_urls() {
        for url in [
            "http://127.0.0.1:7890",
            "https://proxy.example.test:8443",
            "socks5h://127.0.0.1:1080",
        ] {
            configure_proxy(true, url).expect("proxy URL should be accepted");
        }
        configure_proxy(false, "").expect("proxy should be disabled");
    }

    #[test]
    fn rejects_enabled_empty_proxy() {
        let error = configure_proxy(true, " ").expect_err("empty proxy should fail");
        assert!(error.to_string().contains("proxy URL is required"));
    }

    #[test]
    fn parses_windows_proxy_server_forms() {
        assert_eq!(
            parse_windows_proxy_server("127.0.0.1:7890").as_deref(),
            Some("http://127.0.0.1:7890")
        );
        assert_eq!(
            parse_windows_proxy_server(
                "http=127.0.0.1:10809;https=127.0.0.1:10809;socks=127.0.0.1:10808"
            )
            .as_deref(),
            Some("http://127.0.0.1:10809")
        );
        assert_eq!(
            parse_windows_proxy_server("socks=127.0.0.1:10808").as_deref(),
            Some("socks5h://127.0.0.1:10808")
        );
        assert_eq!(
            parse_windows_proxy_server("https=proxy.local:8443").as_deref(),
            // https= still yields an http:// proxy URL (see fn comment).
            Some("http://proxy.local:8443")
        );
        assert_eq!(parse_windows_proxy_server("  ").as_deref(), None);
    }

    #[test]
    fn snippet_truncates_long_bodies() {
        let body = "x".repeat(ERROR_SNIPPET_CHARS + 40);
        assert_eq!(http_err_snippet(&body).len(), ERROR_SNIPPET_CHARS);
        assert_eq!(http_err_snippet("short body"), "short body");
    }

    #[test]
    fn github_api_auth_only_targets_direct_api_host() {
        assert!(is_direct_github_api_url("https://api.github.com/repos/o/r"));
        assert!(!is_direct_github_api_url(
            "https://codeload.github.com/o/r/tar.gz/main"
        ));
    }

    #[test]
    fn configure_proxy_clears_system_proxy_cache() {
        let slot = SYSTEM_PROXY.get_or_init(|| RwLock::new((None, None)));
        {
            let mut guard = slot.write().unwrap();
            *guard = (
                Some("http://127.0.0.1:7890".to_string()),
                Some(Instant::now()),
            );
        }
        configure_proxy(false, "").expect("disable proxy");
        let guard = slot.read().unwrap();
        assert!(guard.0.is_none());
        assert!(guard.1.is_none());
    }

    #[test]
    fn parses_env_proxy_values() {
        assert_eq!(
            parse_env_proxy_value("  http://127.0.0.1:7890 ").as_deref(),
            Some("http://127.0.0.1:7890")
        );
        assert_eq!(
            parse_env_proxy_value("127.0.0.1:7890").as_deref(),
            Some("http://127.0.0.1:7890")
        );
        assert_eq!(
            parse_env_proxy_value("socks5h://127.0.0.1:1080").as_deref(),
            Some("socks5h://127.0.0.1:1080")
        );
        assert_eq!(parse_env_proxy_value("   "), None);
    }

    #[test]
    fn parses_macos_scutil_proxy_output() {
        let sample = "\
<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
}
";
        assert_eq!(
            parse_macos_scutil_proxy(sample).as_deref(),
            Some("http://127.0.0.1:7890")
        );
        let socks_only = "\
<dictionary> {
  HTTPEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 1080
  SOCKSProxy : 127.0.0.1
}
";
        assert_eq!(
            parse_macos_scutil_proxy(socks_only).as_deref(),
            Some("socks5h://127.0.0.1:1080")
        );
        let disabled = "\
<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
  SOCKSEnable : 0
}
";
        assert_eq!(parse_macos_scutil_proxy(disabled), None);
    }
}
