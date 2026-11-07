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
/// a list fetch or app open). `key` = the App Group totals key: the
/// server's `badgeKey` (K2 0.46.1) when known, else its tunnel label.
/// `subdomain` = the older form of the same (a tunnel label); `key` wins.
/// `waiting` absent keeps the stored value.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerTotalsRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subdomain: Option<String>,
    pub unread: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waiting: Option<u32>,
}

/// `clear_server_totals()` request: a server was removed / signed out, or
/// moved to a new key. `key` as in `ServerTotalsRequest` (`subdomain`: the
/// older form; `key` wins).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearServerTotalsRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subdomain: Option<String>,
}

/// One chat in a `clear_delivered()` request: `kind` "thread" (`id` = the
/// conversationId) or "project" (`id` = the group id); `seq` = read up to
/// (read) or read cursor of a chat still unread (keepOnly); absent = all.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearDeliveredChat {
    pub kind: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
}

/// `clear_delivered()` request: remove delivered Thread / project-chat
/// notifications from one server that a read covers (iOS
/// `K2DeliveredClear`). `mode` "read" = these chats were read up to their
/// seq; "keepOnly" = only these chats are still unread, every other one
/// from the server goes. `before` = ms since 1970 the state is from.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearDeliveredRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub badge_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subdomain: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    pub mode: String,
    pub chats: Vec<ClearDeliveredChat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<f64>,
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
/// (`servers` = `{"<key>": {unread, waiting, at}}`, key = badgeKey or
/// tunnel label) plus the sum.
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

/// `pick_media()` / `pick_documents()` request (the composer's attach
/// menu). All optional: `limit` (media only, 1..=10, default 10),
/// `maxBytes` per file (default 50 MB), `maxTotalBytes` for the whole
/// pick (default 100 MB).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_total_bytes: Option<u64>,
}

/// One picked file: its name, MIME type and bytes (base64).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedFile {
    pub name: String,
    pub mime: String,
    pub base64: String,
}

/// A picked file left out: "too large", "total size limit",
/// "unreadable", "unsupported type".
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedFile {
    pub name: String,
    pub reason: String,
}

/// `pick_media()` / `pick_documents()` response. `cancelled` = the user
/// closed the picker without choosing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickResponse {
    #[serde(default)]
    pub files: Vec<PickedFile>,
    #[serde(default)]
    pub skipped: Vec<SkippedFile>,
    #[serde(default)]
    pub cancelled: bool,
}

/// `scan_qr()` response (iOS, "Pair with a code"): the first QR's text
/// ("" unless one was read); `cancelled` when closed without one; `denied`
/// when the camera is off for K2.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanQrResponse {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub cancelled: bool,
    #[serde(default)]
    pub denied: bool,
}

/// `call_op` (iOS): the voice-room call's system UI (CallKit, K2CallShim).
///   `start {room, server}` → `{ok, error?}`; `report {state?, reason?, video?}`;
///   `mute {on}`; `title {title}`; `end`; `speaker {on}` → `{ok, route}`;
///   `autoSpeaker {on}` → `{ok, route}` (video's speaker; off undoes only its own);
///   `route` → `{route, active, autoSpeaker}`; `mic` → `{mic: granted|denied}`
///   (asks the first time); `pipLayer {on}` → `{ok}` puts PiP's display layer
///   in the window (on) or takes it down (off) for the frames of [`crate::pip`];
///   `pipFrame {x, y, w, h, visible, radius?, corners?, animate?}` (webview
///   points) shows that layer over the call screen's video tile, `visible:
///   false` puts it back; `corners: "top"` rounds only the top two (the
///   floating card's picture, its controls strip under it); `animate`
///   ([`PipAnimate`]) gets it there on its own (the floating tile's snap); `haptic {state?: "prepare"}` a light tap (or warms it up).
///   Screen share (iPhone): `appGroup` → `{ok, path}` the App Group's
///   container (the voice plugin's ring goes there); `broadcastPicker` →
///   `{ok}` opens iOS's broadcast sheet with K2's extension (K2Broadcast);
///   `broadcastPickerStop` → `{ok}` opens it to stop sharing (no iOS alert)
///   and answers once it's gone; `broadcastPickerClose` → `{ok}` closes
///   that sheet (the share started or stopped; it has no close button).
///   Events come back as `call`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallOpRequest {
    pub op: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub room: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub w: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub h: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radius: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub corners: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub animate: Option<PipAnimate>,
}

/// `pipFrame`'s `animate`: how the layer moves from where it is to the new
/// frame. With `stiffness`, a Core Animation spring (`mass`, `stiffness`,
/// `damping`) carrying `velocityX`/`velocityY` (points/s) in; without, an
/// ease-out. `duration` in seconds either way (the page's JS runs the same);
/// `startedAt` (wall clock, ms): when the page started it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipAnimate {
    pub duration: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mass: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stiffness: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub damping: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub velocity_x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub velocity_y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<f64>,
}

/// Login tokens in the Keychain (iOS): `set`, `remove`, or `sync` the set.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenOpRequest {
    pub op: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<std::collections::HashMap<String, String>>,
}

/// `e2e_op` (K2 0.46.3 `push-e2e-v1`, iOS): the phone's push keys.
///   `key {server, subdomain, rotate?}` → `{available, publicKey, psk, createdAt, keyId}`
///   (base64url; made on first use; `rotate` makes a new one);
///   `forget {server}`; `enforce {subdomain, on}`; `diagnostics` →
///   `{available, keys:[{server, subdomain, keyId, createdAt, retireAt, enclave}], pushes:[…]}`
///   (never a private key, PSK or decrypted text).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eOpRequest {
    pub op: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subdomain: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rotate: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on: Option<bool>,
}

/// `voice_key` (iOS, Rust only: no JS permission): the voice call's E2EE
/// device key in the Secure Enclave. `op`: `public` → `{public: base64|null}`,
/// `generate` → `{public}`, `sign {message: base64}` → `{signature: base64 DER}`,
/// `delete`. `id` is Sew's `DeviceKeyId::account()`.
#[derive(Debug, Serialize)]
pub struct VoiceKeyRequest {
    pub op: &'static str,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// `voice_notice` (iOS, Rust only): the local notification for a recording
/// notice that waits for an answer while the app is in the background.
/// `post {title, body}` (nothing while the app is active, or without
/// notification permission: it never asks); `clear` takes it away.
#[derive(Debug, Serialize)]
pub struct VoiceNoticeRequest {
    pub op: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

/// `voice_watch` (iOS, Rust only): the call shim's events (`end_requested`,
/// `mute_requested`, `session_activated`, `network_changed`, …) on `channel`.
#[derive(Serialize)]
pub struct VoiceWatchRequest {
    pub channel: tauri::ipc::Channel<serde_json::Value>,
}
