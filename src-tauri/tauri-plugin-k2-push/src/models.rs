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
