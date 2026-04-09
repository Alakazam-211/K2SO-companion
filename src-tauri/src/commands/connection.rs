use serde::Serialize;
use std::time::Instant;

#[derive(Serialize)]
pub struct HealthCheck {
    pub ok: bool,
    pub latency_ms: u64,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn check_health(server_url: String) -> HealthCheck {
    let start = Instant::now();
    let url = format!("{}/companion/status", server_url.trim_end_matches('/'));

    match reqwest::get(&url).await {
        Ok(response) => {
            let latency = start.elapsed().as_millis() as u64;
            HealthCheck {
                ok: response.status().is_success() || response.status().as_u16() == 401,
                latency_ms: latency,
                error: None,
            }
        }
        Err(e) => HealthCheck {
            ok: false,
            latency_ms: start.elapsed().as_millis() as u64,
            error: Some(e.to_string()),
        },
    }
}
