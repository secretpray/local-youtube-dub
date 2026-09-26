//! HTTP to servers on this machine (Ollama, llama-server). ureq replaced the
//! curl process the host used to start per request: one process less per
//! phrase, timeouts that say they were timeouts, and on Windows no console
//! window for it to flash.

use serde_json::Value;
use std::time::Duration;

pub enum HttpError {
    Timeout,
    Other(String),
}

/// An HTTP client for servers on this machine: no proxy (a system proxy must
/// never see local traffic, and would not reach 127.0.0.1 anyway), and HTTP
/// errors kept as answers so their body can be reported.
pub fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .proxy(None)
        .http_status_as_error(false)
        .build()
        .into()
}

pub fn get_json(agent: &ureq::Agent, url: &str) -> Result<Value, HttpError> {
    read_json(agent.get(url).call())
}

pub fn post_json(
    agent: &ureq::Agent,
    url: &str,
    body: &Value,
    bearer: Option<&str>,
) -> Result<Value, HttpError> {
    let mut request = agent.post(url).header("Content-Type", "application/json");
    if let Some(key) = bearer {
        request = request.header("Authorization", format!("Bearer {key}"));
    }
    read_json(request.send(body.to_string()))
}

fn read_json(
    result: Result<ureq::http::Response<ureq::Body>, ureq::Error>,
) -> Result<Value, HttpError> {
    let mut response = result.map_err(|error| match error {
        ureq::Error::Timeout(_) => HttpError::Timeout,
        other => HttpError::Other(other.to_string()),
    })?;
    let status = response.status();
    let text = response
        .body_mut()
        .read_to_string()
        .map_err(|error| match error {
            ureq::Error::Timeout(_) => HttpError::Timeout,
            other => HttpError::Other(other.to_string()),
        })?;
    if !status.is_success() {
        return Err(HttpError::Other(format!("HTTP {status}: {}", text.trim())));
    }
    serde_json::from_str(&text).map_err(|error| HttpError::Other(format!("bad JSON: {error}")))
}
