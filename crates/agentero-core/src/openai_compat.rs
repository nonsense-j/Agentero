//! Generic OpenAI-compatible HTTP helpers shared by the desktop Host and CLI tools.

use serde_json::Value;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::time::Instant;

fn strip_trailing_ci_suffix<'a>(value: &'a str, suffix: &str) -> Option<&'a str> {
    if value.len() < suffix.len() {
        return None;
    }
    let split = value.len() - suffix.len();
    if value.is_char_boundary(split) && value[split..].eq_ignore_ascii_case(suffix) {
        Some(&value[..split])
    } else {
        None
    }
}

/// Resolve an OpenAI-compatible endpoint URL (`suffix` is e.g. `"/chat/completions"`
/// or `"/models"`), preventing double suffixes and defaulting bare origins to `/v1{suffix}`.
pub fn resolve_openai_compatible_url(
    base_url: &str,
    default_root: &str,
    suffix: &str,
) -> Result<reqwest::Url, String> {
    let trimmed = base_url.trim();
    let raw = if trimmed.is_empty() {
        default_root.trim()
    } else {
        trimmed
    };
    let mut cleaned = raw.trim_end_matches('/');
    for known in ["/chat/completions", "/models"] {
        if let Some(rest) = strip_trailing_ci_suffix(cleaned, known) {
            cleaned = rest.trim_end_matches('/');
            break;
        }
    }
    let mut url = reqwest::Url::parse(cleaned).map_err(|e| e.to_string())?;
    let scheme = url.scheme();
    if (scheme != "http" && scheme != "https") || url.host_str().is_none() {
        return Err("OpenAI-compatible base URL must be http(s)".into());
    }
    let path = url.path().trim_end_matches('/').to_string();
    let full_path = if path.is_empty() {
        format!("/v1{suffix}")
    } else {
        format!("{path}{suffix}")
    };
    url.set_path(&full_path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

/// True when two base URLs target the same normalized HTTP(S) host.
pub fn same_endpoint_host(a: &str, b: &str) -> bool {
    let Ok(ua) = resolve_openai_compatible_url(a, "", "") else {
        return false;
    };
    let Ok(ub) = resolve_openai_compatible_url(b, "", "") else {
        return false;
    };
    match (ua.host_str(), ub.host_str()) {
        (Some(ha), Some(hb)) => ha.eq_ignore_ascii_case(hb),
        _ => false,
    }
}

pub fn is_unsupported_param_status(status: u16) -> bool {
    status == 400 || status == 422
}

/// Extract assistant text content from either string or multipart `content` arrays.
pub fn extract_chat_message_content(json: &Value) -> String {
    let Some(content) = json.pointer("/choices/0/message/content") else {
        return String::new();
    };
    if let Some(text) = content.as_str() {
        return text.trim().to_string();
    }
    if let Some(parts) = content.as_array() {
        let joined: String = parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect();
        return joined.trim().to_string();
    }
    String::new()
}

pub fn summarize_error_body(raw: &str) -> String {
    if let Ok(json) = serde_json::from_str::<Value>(raw) {
        if let Some(msg) = json
            .get("error")
            .and_then(|e| e.get("message").or(Some(e)))
            .and_then(Value::as_str)
        {
            let trimmed: String = msg.trim().chars().take(200).collect();
            if !trimmed.is_empty() {
                return trimmed;
            }
        }
    }
    raw.trim()
        .replace(['\r', '\n'], " ")
        .chars()
        .take(200)
        .collect()
}

/// Build an OpenAI-compatible chat request payload, omitting `max_tokens`
/// when `None` so providers apply no artificial output cap.
pub fn build_chat_completions_body(
    model: &str,
    messages: &Value,
    max_tokens: Option<u32>,
    include_reasoning: bool,
    include_temperature: bool,
) -> Value {
    let mut body = serde_json::json!({
        "model": model,
        "messages": messages,
    });
    if include_temperature {
        body["temperature"] = serde_json::json!(0);
    }
    if let Some(limit) = max_tokens {
        body["max_tokens"] = serde_json::json!(limit);
    }
    if include_reasoning {
        body["reasoning"] = serde_json::json!({"effort": "low", "exclude": true});
    }
    body
}

/// Shared start-to-start async pacer used by OpenAlex and LLM request pipelines.
pub async fn acquire_rate_slot(next_slot: &Mutex<Instant>, min_interval: Duration) {
    let wait_until = {
        let mut guard = next_slot.lock().await;
        let now = Instant::now();
        let scheduled = (*guard).max(now);
        *guard = scheduled + min_interval;
        scheduled
    };
    let now = Instant::now();
    if wait_until > now {
        tokio::time::sleep(wait_until - now).await;
    }
}

/// Parameters for [`send_chat_with_reasoning_fallback`].
pub struct ChatFallbackRequest<'a> {
    pub client: &'a reqwest::Client,
    pub endpoint: &'a str,
    pub model: &'a str,
    pub api_key: Option<&'a str>,
    pub messages: &'a Value,
    pub max_tokens: Option<u32>,
    pub reasoning_rejected: Option<&'a AtomicBool>,
}

/// Send a chat completion with `reasoning: { effort: "low", exclude: true }` by default,
/// falling back on HTTP `400`/`422` first without `reasoning`, then minimal `{ model, messages }`.
pub async fn send_chat_with_reasoning_fallback<F, Fut>(
    params: &ChatFallbackRequest<'_>,
    mut before_attempt: F,
) -> Result<reqwest::Response, reqwest::Error>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = ()>,
{
    let try_reasoning = !params
        .reasoning_rejected
        .is_some_and(|flag| flag.load(Ordering::Relaxed));
    let mut tiers: Vec<(bool, bool, Option<u32>)> = Vec::with_capacity(3);
    if try_reasoning {
        tiers.push((true, true, params.max_tokens));
    }
    tiers.push((false, true, params.max_tokens));
    tiers.push((false, false, None));

    let bearer = params.api_key.map(str::trim).filter(|s| !s.is_empty());
    let mut last_resp: Option<reqwest::Response> = None;

    for (idx, &(include_reasoning, include_temperature, tier_max_tokens)) in
        tiers.iter().enumerate()
    {
        before_attempt().await;
        let payload = build_chat_completions_body(
            params.model,
            params.messages,
            tier_max_tokens,
            include_reasoning,
            include_temperature,
        );
        let mut req = params
            .client
            .post(params.endpoint)
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .json(&payload);
        if let Some(key) = bearer {
            req = req.bearer_auth(key);
        }
        let resp = req.send().await?;
        let unsupported = is_unsupported_param_status(resp.status().as_u16());
        if !unsupported && idx == 1 && try_reasoning {
            if let Some(flag) = params.reasoning_rejected {
                flag.store(true, Ordering::Relaxed);
            }
        }
        let is_last = idx + 1 == tiers.len();
        if !unsupported || is_last {
            return Ok(resp);
        }
        last_resp = Some(resp);
    }

    Ok(last_resp.expect("tiers has at least one entry"))
}

#[cfg(test)]
mod tests {
    use super::{build_chat_completions_body, resolve_openai_compatible_url};

    #[test]
    fn resolves_openai_compatible_endpoints_without_double_suffix() {
        let default_root = "https://api.openai.com/v1";
        assert_eq!(
            resolve_openai_compatible_url("", default_root, "/chat/completions")
                .unwrap()
                .as_str(),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            resolve_openai_compatible_url(
                "https://api.openai.com",
                default_root,
                "/chat/completions"
            )
            .unwrap()
            .as_str(),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            resolve_openai_compatible_url("https://api.openai.com/v1/", default_root, "/models")
                .unwrap()
                .as_str(),
            "https://api.openai.com/v1/models"
        );
        assert_eq!(
            resolve_openai_compatible_url(
                "https://open.bigmodel.cn/api/paas/v4/",
                default_root,
                "/chat/completions",
            )
            .unwrap()
            .as_str(),
            "https://open.bigmodel.cn/api/paas/v4/chat/completions"
        );
        assert_eq!(
            resolve_openai_compatible_url(
                "https://api.deepseek.com/v1/chat/completions",
                default_root,
                "/models",
            )
            .unwrap()
            .as_str(),
            "https://api.deepseek.com/v1/models"
        );
    }

    #[test]
    fn builds_chat_completions_body_with_reasoning_low_default_and_fallbacks() {
        let msgs = serde_json::json!([{"role": "user", "content": "hi"}]);

        let primary =
            build_chat_completions_body("ernie-5.5-flash-preview", &msgs, None, true, true);
        assert!(primary.get("max_tokens").is_none());
        assert_eq!(primary.get("temperature").and_then(|v| v.as_i64()), Some(0));
        assert_eq!(
            primary["reasoning"],
            serde_json::json!({"effort": "low", "exclude": true})
        );

        let no_reasoning =
            build_chat_completions_body("gpt-4o-mini", &msgs, Some(1024), false, true);
        assert_eq!(
            no_reasoning.get("max_tokens").and_then(|v| v.as_u64()),
            Some(1024)
        );
        assert!(no_reasoning.get("reasoning").is_none());

        let minimal = build_chat_completions_body("o3-mini", &msgs, None, false, false);
        assert!(minimal.get("temperature").is_none());
        assert!(minimal.get("reasoning").is_none());
        assert!(minimal.get("max_tokens").is_none());
    }
}
