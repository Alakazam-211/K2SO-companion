use serde::{Deserialize, Serialize};

/// `is_available()` response. `available` is the ONLY gate JS trusts;
/// `reason` is diagnostic ("no aps-environment entitlement", "Firebase
/// not configured", "push is mobile-only", ...).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Availability {
    pub available: bool,
    /// "ios" | "android" | "desktop"
    pub platform: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// `request_permission()` response — whether the user granted the OS
/// notification permission (APNs authorization / POST_NOTIFICATIONS).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionResponse {
    pub granted: bool,
}

/// `get_token()` response. `platform` is the DAEMON-facing value the
/// register-device body wants: "apns" (iOS) | "fcm" (Android).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenResponse {
    pub token: String,
    pub platform: String,
}

/// `get_launch_tap()` response — the buffered cold-start tap payload
/// (`{kind, feedbackId?|groupId?, subdomain?}`), if any. Reading it
/// drains the native buffer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchTapResponse {
    #[serde(default)]
    pub tap: Option<serde_json::Value>,
}

/// One workspace avatar for the notification avatar cache (iOS
/// Communication Notifications). `key` = `<subdomain>|<projectId>`
/// lowercased; `rev` changes when the picture does; `dataUrl` is a
/// `data:image/...;base64,` URL.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvatarItem {
    pub key: String,
    pub rev: String,
    pub data_url: String,
}

/// `cache_avatars()` request body (forwarded to the native layer as-is).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheAvatarsRequest {
    pub items: Vec<AvatarItem>,
}

/// `cache_avatars()` response. `available` false = no App Group
/// container (entitlement missing) or a platform without the cache
/// (Android, desktop); `reason` says which.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheAvatarsResponse {
    pub available: bool,
    #[serde(default)]
    pub written: u32,
    #[serde(default)]
    pub skipped: u32,
    #[serde(default)]
    pub failed: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// `set_server_totals()` request: one server's totals (from a live frame,
/// a list fetch or app open). `subdomain` = the server's tunnel label;
/// `waiting` absent keeps the stored value.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerTotalsRequest {
    pub subdomain: String,
    pub unread: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waiting: Option<u32>,
}

/// `clear_server_totals()` request: a server was removed / signed out.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearServerTotalsRequest {
    pub subdomain: String,
}

/// `set_server_totals()` / `clear_server_totals()` response: the new
/// app-icon badge (sum of `unread` across servers). `available` false =
/// no App Group container, or not iOS.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BadgeSumResponse {
    pub available: bool,
    #[serde(default)]
    pub sum: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl BadgeSumResponse {
    pub fn unavailable(reason: &str) -> Self {
        Self {
            available: false,
            sum: 0,
            reason: Some(reason.into()),
        }
    }
}

/// `get_badge_totals()` response: `<AppGroup>/badges/totals.json`
/// (`servers` = `{"<subdomain>": {unread, waiting, at}}`) plus the sum.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BadgeTotalsResponse {
    pub available: bool,
    #[serde(default)]
    pub sum: u32,
    #[serde(default = "one")]
    pub version: u32,
    #[serde(default)]
    pub servers: serde_json::Map<String, serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl BadgeTotalsResponse {
    pub fn unavailable(reason: &str) -> Self {
        Self {
            available: false,
            sum: 0,
            version: 1,
            servers: Default::default(),
            reason: Some(reason.into()),
        }
    }
}

/// `get_badge_diagnostics()` response: `<AppGroup>/badges/received.json`,
/// `days` = `{"YYYY-MM-DD": {"<subdomain>": {silent, alert, lastAt?}}}`
/// (local days, last 30 kept).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BadgeDiagnosticsResponse {
    pub available: bool,
    #[serde(default = "one")]
    pub version: u32,
    #[serde(default)]
    pub days: serde_json::Map<String, serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl BadgeDiagnosticsResponse {
    pub fn unavailable(reason: &str) -> Self {
        Self {
            available: false,
            version: 1,
            days: Default::default(),
            reason: Some(reason.into()),
        }
    }
}

fn one() -> u32 {
    1
}
