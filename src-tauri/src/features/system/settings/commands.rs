//! App settings commands — durable XDG config file.
//!
//! `settings_set` is schema-agnostic: validate proxy → persist → broadcast.
//! Domain reactions (connector port rebind, agent proxy, import parser
//! refresh, jobs layout cap) subscribe via [`AppSettingsStore::subscribe`]
//! at app assembly, so this feature imports no other domain.

use crate::core::error::{map_err, ApiResult};
use crate::features::system::settings::{AppSettings, AppSettingsStore, SettingsGetResult};
use tauri::{AppHandle, Emitter, Manager, State, Url, WebviewUrl, WebviewWindowBuilder};

const PROXY_LOGIN_WINDOW: &str = "institution-proxy-login";

fn proxy_gateway_url(prefix: &str) -> Result<Url, String> {
    let url = Url::parse(prefix.trim()).map_err(|e| e.to_string())?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("institution proxy must be an HTTPS gateway URL".into());
    }
    Ok(url)
}

/// Open the configured gateway in a dedicated webview for interactive SSO.
/// Async is required when creating a window from WebView2 on Windows.
/// Resolves once the login window closes; `true` when a cookie was captured.
#[tauri::command]
#[specta::specta]
pub async fn institution_proxy_login_open(app: AppHandle, prefix: String) -> Result<bool, String> {
    let url = proxy_gateway_url(&prefix)?;
    let login_url = if prefix.trim_end().ends_with('=') {
        proxy_gateway_url(&format!(
            "{}{}",
            prefix.trim(),
            urlencoding::encode("https://doi.org/10.1038/nature12373")
        ))?
    } else {
        url
    };
    let title = login_url.host_str().unwrap_or_default().to_string();
    if let Some(window) = app.get_webview_window(PROXY_LOGIN_WINDOW) {
        window.navigate(login_url).map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    } else {
        WebviewWindowBuilder::new(&app, PROXY_LOGIN_WINDOW, WebviewUrl::External(login_url))
            .title(title)
            .inner_size(1000.0, 750.0)
            .build()
            .map_err(|e| e.to_string())?;
    }
    Ok(monitor_institution_login(app, prefix.trim().to_string()).await)
}

const CARSI_PUBLISHER_ORIGINS: &[&str] = &[
    "https://dl.acm.org",
    "https://ieeexplore.ieee.org",
    "https://link.springer.com",
    "https://www.nature.com",
    "https://www.sciencedirect.com",
    "https://onlinelibrary.wiley.com",
];

fn has_institutional_auth_cookie(cookie_header: &str) -> bool {
    let lower = cookie_header.to_ascii_lowercase();
    [
        "_shibsession_",
        "shibstate",
        "erights=",
        "wlsession=",
        "sim-inst-token=",
        "idp_session=",
        "sd_remoteaccess=",
        "sns_session=",
        "maid=",
        "i2kbrck=",
        "almighty=",
        "athens",
        "wengine_vpn_ticket",
        "ezproxy",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn is_sso_or_wayf_url(url: &Url) -> bool {
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let path = url.path().to_ascii_lowercase();
    let query = url.query().unwrap_or_default().to_ascii_lowercase();
    host.contains("carsi")
        || host.starts_with("wayf.")
        || host.starts_with("authn.")
        || host.starts_with("idp.")
        || host.starts_with("sso.")
        || host.starts_with("cas.")
        || host.starts_with("login.")
        || host.starts_with("passport.")
        || path.contains("/ssostart")
        || path.contains("/showlogin")
        || path.contains("/wayf")
        || path.contains("/shibboleth")
        || path.contains("/saml")
        || path.contains("/idp/")
        || path.contains("/cas/")
        || path.contains("/login")
        || query.contains("wayf")
}

fn is_authenticated_publisher_landing(url: &Url) -> bool {
    if is_sso_or_wayf_url(url) {
        return false;
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    [
        "dl.acm.org",
        "ieeexplore.ieee.org",
        "link.springer.com",
        "www.nature.com",
        "www.sciencedirect.com",
        "onlinelibrary.wiley.com",
    ]
    .iter()
    .any(|pub_host| host == *pub_host || host.ends_with(&format!(".{pub_host}")))
}

/// Fetch a publisher PDF inside an offscreen WebView sharing the desktop app's
/// persistent cookie jar and Chromium TLS stack (required for CARSI sessions on
/// Cloudflare/Atypon/IEEE endpoints that block non-browser HTTP clients).
pub async fn webview_fetch_publisher_pdf(
    app: AppHandle,
    target_url: String,
) -> Result<Vec<u8>, String> {
    webview_fetch_publisher_pdf_with_options(app, target_url, false, 25).await
}

async fn webview_fetch_publisher_pdf_with_options(
    app: AppHandle,
    target_url: String,
    incognito: bool,
    timeout_secs: u64,
) -> Result<Vec<u8>, String> {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tauri::webview::{DownloadEvent, PageLoadEvent};
    use tokio::sync::{oneshot, Mutex as AsyncMutex};

    static FETCH_SERIALIZER: std::sync::OnceLock<AsyncMutex<()>> = std::sync::OnceLock::new();
    let _guard = FETCH_SERIALIZER
        .get_or_init(|| AsyncMutex::new(()))
        .lock()
        .await;

    let normalized_url =
        if target_url.contains("dl.acm.org/doi/pdf/") && !target_url.contains("download=") {
            format!("{target_url}?download=true")
        } else if target_url.contains("ieeexplore.ieee.org/stampPDF/getPDF.jsp") {
            target_url.replace("/stampPDF/getPDF.jsp", "/stamp/stamp.jsp")
        } else {
            target_url.clone()
        };

    let nav_url = Url::parse(&normalized_url).map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let label = format!("carsi-fetch-{id}");
    let staging_path = std::env::temp_dir().join(format!("agentero-carsi-{id}.pdf"));

    let (tx, rx) = oneshot::channel::<Result<Vec<u8>, String>>();
    let tx_slot = Arc::new(Mutex::new(Some(tx)));

    let dl_tx = Arc::clone(&tx_slot);
    let dl_staging = staging_path.clone();

    let eval_script = r#"
(function () {
  if (window.__agenteroCarsiHandled) return;
  window.__agenteroCarsiHandled = true;
  function signalSentinel(name) {
    try {
      const b = new Blob(["0"], { type: "application/octet-stream" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(b);
      a.download = name;
      (document.body || document.documentElement).appendChild(a);
      a.click();
    } catch (_) {}
  }
  const href = String(location.href || "");
  const lower = href.toLowerCase();
  if (
    lower.includes("/ssostart") ||
    lower.includes("/showlogin") ||
    lower.includes("wayf") ||
    lower.includes("carsi") ||
    lower.includes("/shibboleth") ||
    lower.includes("/saml") ||
    lower.includes("/idp/") ||
    lower.includes("/cas/") ||
    lower.includes("authn.sd.elsevier")
  ) {
    signalSentinel("__agentero_auth_required__");
    return;
  }
  function pickPdfUrl() {
    if (lower.includes("/doi/pdf/") || lower.endsWith(".pdf") || lower.includes("pdfft")) {
      return href;
    }
    const iframe = document.querySelector('iframe[src*="getPDF.jsp"], iframe[src*=".pdf"]');
    if (iframe && iframe.src) return iframe.src;
    const meta = document.querySelector('meta[name="citation_pdf_url"]');
    if (meta && meta.content) {
      try {
        const u = new URL(meta.content, href);
        if (u.origin === location.origin) return u.href;
      } catch (_) {}
    }
    const sel = 'a[href*="/doi/pdf/"], a[href*="/content/pdf/"], a[href*="pdfft"], a[href*="pdfdirect"]';
    const link = document.querySelector(sel);
    if (link && link.href) return link.href;
    const arMatch = /arnumber=(\d+)/i.exec(href) || /\/document\/(\d+)/i.exec(href);
    if (lower.includes("ieeexplore.ieee.org") && arMatch) {
      return location.origin + "/stampPDF/getPDF.jsp?tp=&arnumber=" + arMatch[1] + "&ref=";
    }
    return href;
  }
  (async function () {
    try {
      await new Promise((r) => setTimeout(r, 350));
      const pdfUrl = pickPdfUrl();
      const resp = await fetch(pdfUrl, { credentials: "include" });
      if (resp.status === 401 || resp.status === 403) {
        signalSentinel("__agentero_auth_required__");
        return;
      }
      const buf = await resp.arrayBuffer();
      const head = new Uint8Array(buf.slice(0, 5));
      if (head.length >= 4 && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) {
        const blob = new Blob([buf], { type: "application/pdf" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "paper.pdf";
        (document.body || document.documentElement).appendChild(a);
        a.click();
        return;
      }
      const txt = new TextDecoder().decode(buf.slice(0, 4096)).toLowerCase();
      if (
        txt.includes("institutional sign in") ||
        txt.includes("access through your institution") ||
        txt.includes("get access") ||
        txt.includes("purchase pdf") ||
        txt.includes("shibboleth") ||
        txt.includes("sign in")
      ) {
        signalSentinel("__agentero_auth_required__");
      } else {
        signalSentinel("__agentero_not_pdf__");
      }
    } catch (_) {
      signalSentinel("__agentero_not_pdf__");
    }
  })();
})();
"#;

    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(nav_url))
        .title("CARSI PDF Fetch")
        .inner_size(900.0, 700.0)
        .visible(false);
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    if incognito {
        builder = builder.incognito(true);
    }
    let build_res = builder
        .on_download(move |_webview, event| match event {
            DownloadEvent::Requested { destination, .. } => {
                let fname = destination
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or_default();
                if fname.contains("__agentero_auth_required__") {
                    if let Ok(mut guard) = dl_tx.lock() {
                        if let Some(sender) = guard.take() {
                            let _ = sender.send(Err(
                                "authentication required: institutional session missing or expired"
                                    .into(),
                            ));
                        }
                    }
                    return false;
                }
                if fname.contains("__agentero_not_pdf__") {
                    if let Ok(mut guard) = dl_tx.lock() {
                        if let Some(sender) = guard.take() {
                            let _ = sender.send(Err(
                                "response was HTML, not a PDF (institution may not subscribe to this resource)"
                                    .into(),
                            ));
                        }
                    }
                    return false;
                }
                *destination = dl_staging.clone();
                true
            }
            DownloadEvent::Finished { path, success, .. } => {
                let file_path = path.unwrap_or_else(|| dl_staging.clone());
                let outcome = if !success {
                    Err("browser PDF download failed".into())
                } else {
                    match std::fs::read(&file_path) {
                        Ok(bytes) if bytes.len() >= 4 && &bytes[..4] == b"%PDF" => Ok(bytes),
                        Ok(_) => Err(
                            "authentication required: downloaded content was not a PDF".into(),
                        ),
                        Err(e) => Err(format!("failed reading downloaded PDF: {e}")),
                    }
                };
                let _ = std::fs::remove_file(&file_path);
                if let Ok(mut guard) = dl_tx.lock() {
                    if let Some(sender) = guard.take() {
                        let _ = sender.send(outcome);
                    }
                }
                true
            }
            _ => true,
        })
        .on_page_load(move |webview, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let _ = webview.eval(eval_script);
            }
        })
        .build();

    if let Err(e) = build_res {
        let _ = std::fs::remove_file(&staging_path);
        return Err(e.to_string());
    }

    let result = match tokio::time::timeout(Duration::from_secs(timeout_secs), rx).await {
        Ok(Ok(res)) => res,
        Ok(Err(_)) => Err("CARSI browser PDF channel closed unexpectedly".into()),
        Err(_) => Err("timed out waiting for publisher PDF in browser session".into()),
    };

    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.close();
    }
    let _ = std::fs::remove_file(&staging_path);
    result
}

async fn monitor_institution_login(app: AppHandle, prefix: String) -> bool {
    use agentero_core::features::paper::import::download::{
        merge_carsi_cookie_map, probe_institution_proxy, InstitutionProxyKind,
    };
    use std::time::Duration;

    let gateway_url = match proxy_gateway_url(&prefix) {
        Ok(url) => url,
        Err(_) => return false,
    };
    let mut last_cookie = app
        .state::<AppSettingsStore>()
        .institution_proxy()
        .map(|(_, _, cookie)| cookie)
        .unwrap_or_default();
    let mut persisted_any = false;
    let mut last_probed_landing = String::new();
    let mut interval = tokio::time::interval(Duration::from_secs(2));
    loop {
        interval.tick().await;
        let Some(window) = app.get_webview_window(PROXY_LOGIN_WINDOW) else {
            return persisted_any;
        };
        let store = app.state::<AppSettingsStore>();
        let Some((kind, saved_prefix, existing_cookie)) = store.institution_proxy() else {
            continue;
        };
        if saved_prefix != prefix.trim_end_matches('/') && saved_prefix != prefix {
            continue;
        }

        if kind == InstitutionProxyKind::Carsi {
            let current_url = window.url().ok();
            let landed_on_publisher = current_url
                .as_ref()
                .is_some_and(is_authenticated_publisher_landing);

            let mut origins: Vec<Url> = vec![gateway_url.clone()];
            if let Some(cur) = &current_url {
                if !origins
                    .iter()
                    .any(|existing| existing.host_str() == cur.host_str())
                {
                    origins.push(cur.clone());
                }
            }
            for raw in CARSI_PUBLISHER_ORIGINS {
                if let Ok(u) = Url::parse(raw) {
                    if !origins
                        .iter()
                        .any(|existing| existing.host_str() == u.host_str())
                    {
                        origins.push(u);
                    }
                }
            }
            let win = window.clone();
            let collected = tauri::async_runtime::spawn_blocking(move || {
                let mut pairs: Vec<(String, String)> = Vec::new();
                for u in origins {
                    let Some(host) = u.host_str().map(str::to_string) else {
                        continue;
                    };
                    if let Ok(cookies) = win.cookies_for_url(u) {
                        let joined = cookies
                            .into_iter()
                            .map(|c| format!("{}={}", c.name(), c.value()))
                            .collect::<Vec<_>>()
                            .join("; ");
                        if !joined.is_empty() {
                            pairs.push((host, joined));
                        }
                    }
                }
                pairs
            })
            .await
            .unwrap_or_default();
            if collected.is_empty() {
                continue;
            }
            let merged = merge_carsi_cookie_map(&existing_cookie, &collected);
            let has_auth_cookie = collected
                .iter()
                .any(|(_, c)| has_institutional_auth_cookie(c));

            if (landed_on_publisher || has_auth_cookie) && merged != existing_cookie {
                if let Ok(Some(settings)) =
                    store.update_institution_proxy_cookie(&saved_prefix, merged.clone())
                {
                    let _ = app.emit("settings:changed", settings);
                    persisted_any = true;
                }
            }

            if !landed_on_publisher {
                continue;
            }
            let landing_key = format!(
                "{}|{}",
                current_url
                    .as_ref()
                    .and_then(|u| u.host_str())
                    .unwrap_or_default(),
                merged
            );
            if landing_key == last_probed_landing {
                continue;
            }
            last_probed_landing = landing_key;

            if probe_institution_proxy(kind, &saved_prefix, &merged)
                .await
                .is_ok()
            {
                if let Ok(Some(settings)) =
                    store.update_institution_proxy_cookie(&saved_prefix, merged)
                {
                    let _ = app.emit("settings:changed", settings);
                }
                if let Some(win) = app.get_webview_window(PROXY_LOGIN_WINDOW) {
                    let _ = win.close();
                }
                return true;
            }
            continue;
        }

        let url = gateway_url.clone();
        let candidate_cookie =
            match tauri::async_runtime::spawn_blocking(move || window.cookies_for_url(url)).await {
                Ok(Ok(cookies)) => cookies
                    .into_iter()
                    .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
                    .collect::<Vec<_>>()
                    .join("; "),
                _ => continue,
            };

        if candidate_cookie.is_empty() || candidate_cookie == last_cookie {
            continue;
        }
        last_cookie = candidate_cookie.clone();
        if probe_institution_proxy(kind, &saved_prefix, &candidate_cookie)
            .await
            .is_err()
        {
            continue;
        }
        let Ok(Some(settings)) =
            store.update_institution_proxy_cookie(&saved_prefix, candidate_cookie)
        else {
            continue;
        };
        let _ = app.emit("settings:changed", settings);
        if let Some(window) = app.get_webview_window(PROXY_LOGIN_WINDOW) {
            let _ = window.close();
        }
        return true;
    }
}

#[tauri::command]
#[specta::specta]
pub fn settings_get(store: State<'_, AppSettingsStore>) -> ApiResult<SettingsGetResult> {
    match store.get() {
        Ok(r) => ApiResult::ok(r),
        Err(e) => map_err(e),
    }
}

/// Detected OS system proxy (Windows "Internet Settings"). Host requests
/// already fall back to it when the app proxy is off; the updater plugin and
/// the settings UI query it here.
#[tauri::command]
#[specta::specta]
pub fn network_system_proxy() -> ApiResult<Option<String>> {
    ApiResult::ok(crate::core::http::system_proxy_url())
}

/// Return unique system font family names (sorted). Empty on mobile / failure.
///
/// Scanning system fonts is slow (disk walk on Windows), so it runs in
/// `run_blocking` and the result is cached for the process lifetime — the
/// installed-font set does not change while the app is running.
#[tauri::command]
#[specta::specta]
pub async fn list_system_fonts() -> ApiResult<Vec<String>> {
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        ApiResult::ok(Vec::new())
    }
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        use crate::core::blocking::run_blocking;
        use std::sync::OnceLock;

        static FONTS: OnceLock<Vec<String>> = OnceLock::new();
        if let Some(names) = FONTS.get() {
            return ApiResult::ok(names.clone());
        }
        run_blocking(move || {
            let names = FONTS.get_or_init(|| {
                use std::collections::BTreeSet;
                let mut db = fontdb::Database::new();
                db.load_system_fonts();
                let mut names = BTreeSet::new();
                for face in db.faces() {
                    for (family, _) in &face.families {
                        let t = family.trim();
                        if !t.is_empty() {
                            names.insert(t.to_string());
                        }
                    }
                }
                names.into_iter().collect()
            });
            ApiResult::ok(names.clone())
        })
        .await
    }
}

/// Persist the full settings snapshot and broadcast `settings:changed`.
///
/// Domain side effects are not wired here: they run as
/// [`AppSettingsStore::subscribe`] listeners registered by the app assembly
/// (see `app/mod.rs`), fired inside `store.set` with the redacted snapshot.
#[tauri::command]
#[specta::specta]
pub fn settings_set(
    app: AppHandle,
    store: State<'_, AppSettingsStore>,
    settings: AppSettings,
) -> ApiResult<AppSettings> {
    if let Err(e) = crate::core::http::configure_proxy(
        settings.network_proxy_enabled,
        &settings.network_proxy_url,
    ) {
        return map_err(e);
    }
    match store.set(settings) {
        Ok(s) => {
            // Keep every window's settings cache fresh (settings window, main windows).
            let _ = app.emit("settings:changed", &s);
            ApiResult::ok(s)
        }
        Err(e) => map_err(e),
    }
}

/// Probe the configured institution proxy (EZProxy/WebVPN/CARSI) by fetching a
/// known paywalled DOI through the rewrite and checking the response is a
/// PDF. Optional `prefix_override` tests a specific gateway or CARSI publisher
/// without clobbering saved settings.
#[tauri::command]
#[specta::specta]
pub async fn institution_proxy_probe(
    app: AppHandle,
    prefix_override: Option<String>,
) -> ApiResult<String> {
    let store = app.state::<AppSettingsStore>();
    let Some((kind, prefix, cookie)) =
        store.institution_proxy_with_override(prefix_override.as_deref())
    else {
        return ApiResult::err(agentero_core::error::AppError::message(
            "prefix not configured",
        ));
    };
    match agentero_core::features::paper::import::download::probe_institution_proxy(
        kind, &prefix, &cookie,
    )
    .await
    {
        Ok(n) => ApiResult::ok(format!("ok ({n} bytes)")),
        Err(e) => ApiResult::err(agentero_core::error::AppError::domain(
            if e.contains("authentication required") || e.contains("HTTP 401") {
                "institution_proxy_auth_required"
            } else {
                "institution_proxy_probe_failed"
            },
            e,
        )),
    }
}

/// Direct access probe result for a single academic publisher (`ieee` or `acm`).
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PublisherAccessProbe {
    pub publisher: String,
    pub direct_ok: bool,
    pub status: String,
    pub detail: String,
}

/// Combined direct campus-network access detection for IEEE Xplore and ACM DL.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InstitutionAccessDetectResult {
    pub ieee: PublisherAccessProbe,
    pub acm: PublisherAccessProbe,
    pub needs_gateway: bool,
}

fn classify_direct_probe(publisher: &str, res: Result<Vec<u8>, String>) -> PublisherAccessProbe {
    match res {
        Ok(bytes) => PublisherAccessProbe {
            publisher: publisher.to_string(),
            direct_ok: true,
            status: "ok".to_string(),
            detail: format!("ok ({} bytes)", bytes.len()),
        },
        Err(e) if e.contains("authentication required") || e.contains("not a PDF") => {
            PublisherAccessProbe {
                publisher: publisher.to_string(),
                direct_ok: false,
                status: "auth_required".to_string(),
                detail: e,
            }
        }
        Err(e) => PublisherAccessProbe {
            publisher: publisher.to_string(),
            direct_ok: false,
            status: "error".to_string(),
            detail: e,
        },
    }
}

/// Probe IEEE Xplore and ACM Digital Library in an isolated incognito browser
/// session (without saved CARSI/gateway cookies) to determine whether the
/// current network IP already has direct subscription access or requires an
/// institutional gateway.
#[tauri::command]
#[specta::specta]
pub async fn institution_access_detect(app: AppHandle) -> ApiResult<InstitutionAccessDetectResult> {
    let ieee_res = webview_fetch_publisher_pdf_with_options(
        app.clone(),
        "https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=7194613".to_string(),
        true,
        15,
    )
    .await;
    let acm_res = webview_fetch_publisher_pdf_with_options(
        app,
        "https://dl.acm.org/doi/pdf/10.1145/2786805.2786814?download=true".to_string(),
        true,
        15,
    )
    .await;
    let ieee = classify_direct_probe("ieee", ieee_res);
    let acm = classify_direct_probe("acm", acm_res);
    let needs_gateway = !(ieee.direct_ok && acm.direct_ok);
    ApiResult::ok(InstitutionAccessDetectResult {
        ieee,
        acm,
        needs_gateway,
    })
}

/// Probe the configured EasyScholar key by querying a stable journal.
/// Returns false when no key is configured, the request fails, or the API
/// rejects the key (non-200 / non-200 code).
#[tauri::command]
#[specta::specta]
pub async fn easy_scholar_probe(app: AppHandle) -> ApiResult<bool> {
    use crate::features::paper::scholar_api::sources::easy_scholar::EasyScholarApi;

    let store = app.state::<AppSettingsStore>();
    let Some(key) = store.easy_scholar_key() else {
        return ApiResult::ok(false);
    };
    let source = EasyScholarApi::new(key);
    let ok = match source.fetch_raw("Nature").await {
        Ok(json) => json
            .get("code")
            .and_then(|v| v.as_i64())
            .is_some_and(|code| code == 200),
        Err(_) => false,
    };
    ApiResult::ok(ok)
}

/// Probe an OpenAlex API key (either `api_key` override or the stored setting)
/// against a lightweight OpenAlex singleton work endpoint.
#[tauri::command]
#[specta::specta]
pub async fn open_alex_probe(app: AppHandle, api_key: Option<String>) -> ApiResult<bool> {
    use crate::features::system::settings::is_translate_api_key_mask;

    let store = app.state::<AppSettingsStore>();
    let resolved = api_key
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty() && !is_translate_api_key_mask(k))
        .or_else(|| store.open_alex_key());
    let Some(key) = resolved else {
        return ApiResult::ok(false);
    };
    let url = format!(
        "https://api.openalex.org/works/W2741809807?select=id&api_key={}",
        urlencoding::encode(&key)
    );
    let client = match crate::core::http::client_with(
        std::time::Duration::from_secs(12),
        crate::core::http::DEFAULT_REDIRECT_LIMIT,
        agentero_core::features::paper::scholar_api::client::USER_AGENT,
    ) {
        Ok(c) => c,
        Err(_) => return ApiResult::ok(false),
    };
    let ok = match client
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .await
    {
        Ok(res) if res.status().is_success() => res
            .json::<serde_json::Value>()
            .await
            .map(|json| json.get("id").and_then(|v| v.as_str()).is_some())
            .unwrap_or(false),
        _ => false,
    };
    ApiResult::ok(ok)
}

/// Resolve the stored OpenAlex API key for internal Plaza batch enrichment while
/// keeping `AppSettings.openAlexKey` masked in UI state.
#[tauri::command]
#[specta::specta]
pub fn open_alex_key_get(app: AppHandle) -> ApiResult<Option<String>> {
    let store = app.state::<AppSettingsStore>();
    ApiResult::ok(store.open_alex_key())
}
