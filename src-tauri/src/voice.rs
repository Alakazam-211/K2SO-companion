//! Voice rooms on the phone (4.2.0, iOS): Sew's native voice plugin
//! (`tauri-plugin-sew-voice`, over sew-call-client and K2's kessel-audio),
//! with what only this app knows:
//!
//! - [`K2Provider`]: the join. Each server's paired-phone token from the
//!   Keychain copy, read fresh every join, and `POST /cli/voice/join` on that
//!   server (K2 0.46.9). The token and the answer stay in Rust.
//! - [`EnclaveKey`]: the call's E2EE device key in the Secure Enclave
//!   (K2DeviceKey.swift). No software fallback: a key error fails the join.
//! - [`CallKitBridge`]: the engine's state drives the system call (CallKit),
//!   and the system's buttons and audio session come back as [`VoiceControl`]
//!   calls. Native both ways, so a call keeps working with the webview asleep.
//! - [`PipSink`]: while the call has video, Sew's native sink on the active
//!   speaker feeds the picture in picture (K2PiP.swift).
//! - [`ScreenRing`]: the iPhone screen share. Once a call is connected the
//!   broadcast extension's ring (K2Broadcast) is armed in the App Group's
//!   container, and the share's state goes to the call screen.
//!
//! The webview drives joins through the plugin's own commands
//! (`plugin:sew-voice|join` …) and follows its `sew-voice://` events.

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, OnceLock, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde_json::{json, Value};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_k2_push::{pip, CallOpRequest, K2PushExt, VoiceKeyRequest, VoiceNoticeRequest, VoiceWatchRequest};
use tauri_plugin_sew_voice::native::{NativePayload, NativeSink, NativeSinkTarget, NativeVideoConsumer, NativeVideoEvent};
use tauri_plugin_sew_voice::sew_call_client::Recording;
use tauri_plugin_sew_voice::{
    AppScene, BoxFuture, CallState, ConsentAnswer, DeviceError, DeviceKeyId, HardwareDeviceKey, JoinAnswer,
    JoinArgs, JoinOptions, JoinProvider, JoinRequest, ProviderError, RecordingControl, RecordingInfo, RecordingRequest,
    SelfMute, StateEvent, VoiceControl, RECORDING_UNSUPPORTED,
    VoiceListener,
};
use tauri_plugin_sew_voice::{ConsentAsk, ConsentPrompt, ErrorInfo};

/// The longest a daemon takes to answer a join (K2 desktop's figure: a
/// reconnecting lane, the member gate and Sew's answer add up to 51 s).
const JOIN_TIMEOUT: Duration = Duration::from_secs(55);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// The daemon lane the engine reaches Sew through.
const API_BASE_PATH: &str = "/_k2/voice/sew/";

/// The app once it's running: the push plugin's native handle lives there.
#[derive(Clone, Default)]
pub struct Native {
    app: Arc<OnceLock<AppHandle<Wry>>>,
    /// Server id → base URL (`https://host`), from the webview's servers.
    hosts: Arc<RwLock<HashMap<String, String>>>,
    /// Which saved servers each Sew install's device keys were made for.
    installs: Arc<Mutex<Option<Installs>>>,
    /// The server of the join in progress (the keys used next are its).
    joining: Arc<Mutex<Option<String>>>,
    /// The last call events, for "Send call log".
    log: Arc<Mutex<CallLog>>,
    /// Why the last call ended when K2 left it itself (the engine says `left`).
    ended_why: Arc<Mutex<Option<&'static str>>>,
    /// The picture in picture's thread ([`pip_loop`]).
    pip: Arc<OnceLock<mpsc::Sender<ToSink>>>,
    /// The CallKit thread ([`callkit_loop`]), for a join with the camera.
    shim: Arc<OnceLock<mpsc::Sender<ToShim>>>,
    /// Whom the picture shows (the sink's last `Switched`), for a call
    /// screen opened after the event went by.
    speaker: Arc<Mutex<Value>>,
    /// The screen share's ring and state ([`ScreenRing`]).
    screen: Arc<Mutex<ScreenRing>>,
    /// The App Group's container (Swift's, asked once: `callOp appGroup`).
    app_group: Arc<OnceLock<PathBuf>>,
}

/// Sew install id → the app's server ids that joined through it. Sew knows
/// installs, the app knows servers: this ties them, so removing a server can
/// forget its install's keys (`forget_server`). Kept in the app's data dir.
#[derive(Debug, Default, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Installs(BTreeMap<String, BTreeSet<String>>);

impl Installs {
    /// True when this is news (worth saving).
    pub fn saw(&mut self, install: u64, server: &str) -> bool {
        self.0.entry(install.to_string()).or_default().insert(server.to_owned())
    }

    /// Drop servers the app no longer has; answer the installs no saved
    /// server uses any more (theirs to forget).
    pub fn prune(&mut self, kept: &dyn Fn(&str) -> bool) -> Vec<u64> {
        let mut orphans = Vec::new();
        self.0.retain(|install, servers| {
            servers.retain(|s| kept(s));
            if servers.is_empty() {
                orphans.extend(install.parse::<u64>().ok());
                false
            } else {
                true
            }
        });
        orphans
    }
}

impl Native {
    fn app(&self) -> Option<AppHandle<Wry>> {
        self.app.get().cloned()
    }

    fn host(&self, server: &str) -> Option<String> {
        let hosts = self.hosts.read().unwrap_or_else(|e| e.into_inner());
        hosts.get(server).map(|u| u.trim_end_matches('/').to_owned())
    }

    fn installs_path(&self) -> Option<std::path::PathBuf> {
        Some(self.app()?.path().app_data_dir().ok()?.join("voice-installs.json"))
    }

    /// The install map, read from disk the first time.
    fn with_installs<T>(&self, f: impl FnOnce(&mut Installs) -> T) -> T {
        let mut slot = self.installs.lock().unwrap_or_else(|e| e.into_inner());
        let installs = slot.get_or_insert_with(|| {
            self.installs_path()
                .and_then(|p| std::fs::read(p).ok())
                .and_then(|b| serde_json::from_slice(&b).ok())
                .unwrap_or_default()
        });
        f(installs)
    }

    fn save_installs(&self) {
        let Some(path) = self.installs_path() else { return };
        let bytes = self.with_installs(|i| serde_json::to_vec(i).unwrap_or_default());
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(path, bytes);
    }

    /// A device key of `install` was used: it belongs to the joining server.
    fn key_used(&self, install: u64) {
        let joining = self.joining.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let Some(server) = joining else { return };
        if self.with_installs(|i| i.saw(install, &server)) {
            self.save_installs();
        }
    }

    /// To the picture in picture's thread. Only queues: safe in a listener.
    fn to_pip(&self, msg: ToSink) {
        if let Some(tx) = self.pip.get() {
            let _ = tx.send(msg);
        }
    }

    /// The Keychain's token for `server`, off the async runtime's workers.
    async fn token(&self, server: &str) -> Option<String> {
        let app = self.app()?;
        let server = server.to_owned();
        tauri::async_runtime::spawn_blocking(move || app.k2_push().token_get(&server))
            .await
            .ok()
            .flatten()
    }
}

/// The voice plugin, set up for this app. Call [`start`] from `setup`.
pub fn plugin(native: &Native) -> tauri::plugin::TauriPlugin<Wry> {
    let (tx, rx) = mpsc::channel();
    let _ = native.shim.set(tx.clone());
    let mut shim = native.clone();
    std::thread::Builder::new()
        .name("k2-callkit".into())
        .spawn(move || callkit_loop(&mut shim, rx))
        .expect("the CallKit thread starts");
    let watch = watch_thread(native);
    let (pip_tx, pip_rx) = mpsc::channel();
    let _ = native.pip.set(pip_tx);
    let mut pip_sink = PipSink { native: native.clone(), sink: None, counts: Arc::new(PipCounts::default()) };
    std::thread::Builder::new()
        .name("k2-pip".into())
        .spawn(move || pip_loop(&mut pip_sink, pip_rx))
        .expect("the PiP thread starts");
    tauri_plugin_sew_voice::Builder::new(K2Provider::new(native.clone()))
        .listener(Arc::new(CallKitBridge { tx, watch, native: native.clone(), held: AtomicBool::new(false) }))
        .hardware_device_key(Arc::new(EnclaveKey { native: native.clone() }))
        .build()
}

/// After the plugins are up: the native handle, and the call shim's events
/// into the engine.
pub fn start(app: &AppHandle<Wry>, native: &Native) {
    let _ = native.app.set(app.clone());
    let control = app.state::<VoiceControl>().inner().clone();
    let log = native.clone();
    let channel = Channel::new(move |body: InvokeResponseBody| {
        if let InvokeResponseBody::Json(text) = body {
            if let Ok(event) = serde_json::from_str::<Value>(&text) {
                let name = event.get("event").and_then(Value::as_str);
                // Up to one a second while a layer waits: not worth the log's lines.
                if name != Some("pip_keyframe") {
                    log.note(&shim_line(&event));
                }
                if name == Some("start_failed") {
                    // The engine's end says `left`: the webview says why instead.
                    *log.ended_why.lock().unwrap_or_else(|e| e.into_inner()) = Some(SYSTEM_CALL_REFUSED);
                }
                on_shim_event(&control, &log, &event);
            }
        }
        Ok(())
    });
    let app = app.clone();
    // run_mobile_plugin blocks until Swift answers: never on the main thread.
    tauri::async_runtime::spawn_blocking(move || {
        let _ = app.k2_push().voice_watch(VoiceWatchRequest { channel });
    });
}

/// The webview's servers (id → base URL), whenever they change. A removed
/// server's call keys go with it, once no other saved server uses its Sew
/// install (and not mid-call: Sew refuses then, and the next change retries).
pub fn set_hosts(native: &Native, hosts: HashMap<String, String>) {
    let orphans = if hosts.is_empty() {
        // The webview before it loaded its servers, or every server removed:
        // only the second is a removal, and the app can't tell here.
        Vec::new()
    } else {
        native.with_installs(|i| i.prune(&|s| hosts.contains_key(s)))
    };
    *native.hosts.write().unwrap_or_else(|e| e.into_inner()) = hosts;
    if orphans.is_empty() {
        return;
    }
    let Some(app) = native.app() else { return };
    let control = app.state::<VoiceControl>().inner().clone();
    let native = native.clone();
    tauri::async_runtime::spawn(async move {
        for install in orphans {
            if control.forget_server(install).await.is_err() {
                // Keep it listed so a later change tries again.
                native.with_installs(|i| {
                    i.0.entry(install.to_string()).or_default().insert(String::new());
                });
            }
        }
        native.save_installs();
    });
}

/// A join with the camera on ("Join with camera"): the system call starts as
/// a video call (`CXStartCallAction.isVideo`), and Sew turns the camera on
/// once the call is connected and the app is in front (never from the lock
/// screen). The webview asked for the camera permission first; without it
/// the call still joins, and `local_video` says why the camera stayed off.
pub async fn join_with_camera(control: &VoiceControl, native: &Native, target: String, room: String) -> Result<Value, ErrorInfo> {
    let to_shim = |video: bool| {
        if let Some(tx) = native.shim.get() {
            let _ = tx.send(ToShim::StartVideo(video));
        }
    };
    // Before the join: the system call starts on its first `connecting`.
    to_shim(true);
    native.note("join with camera");
    let args = JoinArgs { target, room, muted: None, deafened: None };
    match control.join_with(args, JoinOptions::with_camera()).await {
        Ok(joined) => Ok(serde_json::to_value(joined).unwrap_or(Value::Null)),
        Err(e) => {
            to_shim(false);
            Err(e)
        }
    }
}

/// The consent sheet the webview should show now (`null`: none), for a
/// webview that slept through the `k2-voice://consent` event.
pub fn consent_now(control: &VoiceControl) -> Value {
    let snap = control.snapshot();
    let ask = if matches!(snap.state, CallState::ConsentRequired { .. }) { ConsentAsk::Join } else { ConsentAsk::InCall };
    snap.recording.as_ref().and_then(|r| consent_sheet(r, ask)).unwrap_or(Value::Null)
}

// ── The join ─────────────────────────────────────────────────────────

pub struct K2Provider {
    native: Native,
    http: reqwest::Client,
}

impl K2Provider {
    fn new(native: Native) -> K2Provider {
        let http = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(JOIN_TIMEOUT)
            .build()
            .unwrap_or_default();
        K2Provider { native, http }
    }

    /// The server's address and this phone's token there.
    async fn login(&self, server: &str) -> Result<(String, String), ProviderError> {
        // A server the app no longer has, or no token: pair again.
        let base = self.native.host(server).ok_or(ProviderError::SigninRequired)?;
        let token = self.native.token(server).await.ok_or(ProviderError::SigninRequired)?;
        Ok((base, token))
    }

    async fn post(&self, url: &str, token: &str, body: &Value) -> Result<(u16, Option<u64>, Vec<u8>), ProviderError> {
        let res = self.http.post(url).bearer_auth(token).json(body).send().await.map_err(sent_err)?;
        let status = res.status().as_u16();
        let retry_after = res
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok());
        let bytes = res.bytes().await.map_err(sent_err)?;
        Ok((status, retry_after, bytes.to_vec()))
    }

    async fn join_inner(&self, req: JoinRequest) -> Result<JoinAnswer, ProviderError> {
        let (base, token) = self.login(&req.target).await?;
        *self.native.joining.lock().unwrap_or_else(|e| e.into_inner()) = Some(req.target.clone());
        let (status, retry_after, body) = self.post(&format!("{base}/cli/voice/join"), &token, &join_body(&req)).await?;
        answer_from(status, retry_after, &body, &base, &token)
    }

    async fn consent_inner(&self, answer: ConsentAnswer) -> Result<Recording, ProviderError> {
        let (base, token) = self.login(&answer.target).await?;
        let body = json!({
            "recording_id": answer.recording_id,
            "consent": answer.consent,
            "notice_version": answer.notice_version,
        });
        let (status, retry_after, bytes) =
            self.post(&format!("{base}/cli/voice/recording/consent"), &token, &body).await?;
        consent_from(status, retry_after, &bytes, &token)
    }

    /// Record → `recording/start {room}`, Stop → `recording/stop
    /// {recordingId}` (K2 0.46.11, Sew 0.9.2; as K2 desktop's provider). The
    /// daemon maps the room (a slug, or Sew's channel id after a move).
    async fn recording_inner(&self, req: RecordingRequest) -> Result<Recording, ProviderError> {
        let (route, body) = recording_body(&req)?;
        let (base, token) = self.login(&req.target).await?;
        let (status, retry_after, bytes) = self.post(&format!("{base}/cli/voice/{route}"), &token, &body).await?;
        recording_answer_from(status, retry_after, &bytes, &token, RECORDING_UNSUPPORTED)
    }
}

/// Record and Stop's route and body.
pub fn recording_body(req: &RecordingRequest) -> Result<(&'static str, Value), ProviderError> {
    match (req.action, req.recording_id) {
        (RecordingControl::Start, _) => Ok(("recording/start", json!({ "room": req.room }))),
        (RecordingControl::Stop, Some(id)) => Ok(("recording/stop", json!({ "recordingId": id.to_string() }))),
        (RecordingControl::Stop, None) => Err(refused("no_recording", "there is no recording to stop")),
        #[allow(unreachable_patterns)]
        _ => Err(refused(RECORDING_UNSUPPORTED, "this K2 doesn't know that recording action")),
    }
}

/// What the daemon answered a recording answer with, as the plugin's types.
pub fn consent_from(status: u16, retry_after_secs: Option<u64>, body: &[u8], token: &str) -> Result<Recording, ProviderError> {
    recording_answer_from(status, retry_after_secs, body, token, tauri_plugin_sew_voice::CONSENT_UNSUPPORTED)
}

/// The daemon's answer to a consent, Record or Stop: `{recording}` (or Sew's
/// own) → the recording; a refusal as Sew's; a K2 without the route →
/// `unsupported` (not recorded, the safe side).
pub fn recording_answer_from(
    status: u16,
    retry_after_secs: Option<u64>,
    body: &[u8],
    token: &str,
    unsupported: &str,
) -> Result<Recording, ProviderError> {
    let v: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let code = v.pointer("/error/code").and_then(Value::as_str);
    match (status, code) {
        (200, _) => {
            // Sew's recording, or K2's `{recording}` around it.
            let inner = v.get("recording").filter(|r| r.is_object()).map(|r| r.to_string());
            ConsentAnswer::recording_from_json(inner.as_deref().map(str::as_bytes).unwrap_or(body))
        }
        // The notice changed after it was shown. K2 keeps Sew's own refusal
        // in `details.sew`: read as Sew's, the engine shows the new notice.
        (409, Some("consent_notice_changed")) => {
            let sew = json!({ "error": v.pointer("/error/details/sew").cloned().unwrap_or(Value::Null) });
            Err(clean(ProviderError::from_sew_error(409, None, sew.to_string().as_bytes()), token))
        }
        // K2's own 404s answer for the recording or the rooms.
        (404, Some("recording_not_found" | "voice_rooms_off")) => {
            Err(clean(ProviderError::from_sew_error(status, None, body), token))
        }
        // A K2 before the consent route (0.46.9): not recorded, the safe side.
        (404 | 405, _) => Err(refused(unsupported, "this server can't do that with a recording yet")),
        _ => Err(clean(ProviderError::from_sew_error(status, retry_after_secs.map(|s| s * 1000), body), token)),
    }
}

impl JoinProvider for K2Provider {
    fn join(&self, req: JoinRequest) -> BoxFuture<'_, Result<JoinAnswer, ProviderError>> {
        Box::pin(async move {
            let answer = self.join_inner(req).await;
            self.native.note(&format!("join {}", outcome(answer.as_ref().err())));
            answer
        })
    }

    fn consent(&self, answer: ConsentAnswer) -> BoxFuture<'_, Result<Recording, ProviderError>> {
        Box::pin(async move {
            let answer = self.consent_inner(answer).await;
            self.native.note(&format!("consent answer {}", outcome(answer.as_ref().err())));
            answer
        })
    }

    fn recording(&self, req: RecordingRequest) -> BoxFuture<'_, Result<Recording, ProviderError>> {
        Box::pin(async move {
            let what = if req.action == RecordingControl::Stop { "stop" } else { "record" };
            let answer = self.recording_inner(req).await;
            self.native.note(&format!("recording {what} {}", outcome(answer.as_ref().err())));
            answer
        })
    }
}

/// Nothing from a failed request goes up the chain (it could name the URL).
fn sent_err(e: reqwest::Error) -> ProviderError {
    if e.is_timeout() {
        refused("join_timeout", "the server didn't answer in time")
    } else {
        ProviderError::Unavailable { retry_after_ms: None }
    }
}

fn refused(code: &str, hint: &str) -> ProviderError {
    ProviderError::Refused { code: code.into(), detail: json!({ "hint": hint, "details": null }) }
}

/// `POST /cli/voice/join`'s body: Sew's join with the call credential, the
/// same for a join and every re-join. `recording_notice` is the person's
/// answer to a recorded room's notice: without it a held join is refused
/// again.
pub fn join_body(req: &JoinRequest) -> Value {
    let mut join = json!({
        "call_credential": true,
        "self_mute": req.muted || req.deafened,
        "self_deaf": req.deafened,
    });
    if let Some(notice) = &req.recording_notice {
        join["recording_notice"] = json!(notice);
    }
    json!({ "room": req.room, "join": join })
}

/// What the daemon answered, as the plugin's types.
pub fn answer_from(
    status: u16,
    retry_after_secs: Option<u64>,
    body: &[u8],
    base_url: &str,
    token: &str,
) -> Result<JoinAnswer, ProviderError> {
    let v: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    match status {
        200 => {
            let bad = || ProviderError::Other("the server's join answer did not parse".into());
            let join = v.get("join").filter(|j| j.is_object()).ok_or_else(bad)?;
            let bytes = serde_json::to_vec(join).map_err(|_| bad())?;
            let base = url::Url::parse(&format!("{base_url}{API_BASE_PATH}"))
                .map_err(|_| ProviderError::Other("the server's address isn't a URL".into()))?;
            let answer = JoinAnswer::from_json(&bytes, base).map_err(|_| bad())?;
            if answer.call_credential().is_none() {
                return Err(refused("voice_server_too_old", "this server's Sew doesn't give native calls a call credential yet"));
            }
            Ok(answer)
        }
        401 => Err(ProviderError::SigninRequired),
        _ => {
            let error = v.get("error").unwrap_or(&v);
            // A recorded room (Sew's 409, passed through): hold for the answer.
            if error.pointer("/details/reason").and_then(Value::as_str) == Some("recording_consent_required") {
                return Err(ProviderError::from_sew_error(409, None, body));
            }
            match error.get("code").and_then(Value::as_str) {
                // The room, its Sew channel or (a K2 before 0.46.9) the
                // phone's join itself isn't there.
                Some("not_found") if status == 404 => {
                    Err(refused(ROOM_UNAVAILABLE, "the server has no such voice room or join"))
                }
                // `device_session_ended` (pair again), `room_full`, … as K2 said.
                Some(code) => {
                    let detail = json!({
                        "hint": error.get("hint").cloned().unwrap_or(Value::Null),
                        "details": error.get("details").cloned().unwrap_or(Value::Null),
                    });
                    Err(clean(ProviderError::Refused { code: code.to_owned(), detail }, token))
                }
                None if matches!(status, 429 | 502 | 503 | 504) => {
                    Err(ProviderError::Unavailable { retry_after_ms: retry_after_secs.map(|s| s.saturating_mul(1000)) })
                }
                None => Err(ProviderError::Other(format!("the server answered {status}"))),
            }
        }
    }
}

/// A refusal's detail reaches the webview: one that quotes a token (a bug
/// somewhere) goes as nothing.
fn clean(e: ProviderError, token: &str) -> ProviderError {
    match e {
        ProviderError::Refused { code, detail } => {
            let text = detail.to_string();
            let leaks = text.contains("sewcc_") || (!token.is_empty() && text.contains(token));
            ProviderError::Refused { code, detail: if leaks { json!({ "hint": null, "details": null }) } else { detail } }
        }
        other => other,
    }
}

// ── The device key ───────────────────────────────────────────────────

pub struct EnclaveKey {
    native: Native,
}

impl EnclaveKey {
    async fn call(&self, op: &'static str, id: &DeviceKeyId, message: Option<&[u8]>) -> Result<Value, DeviceError> {
        let app = self.native.app().ok_or_else(|| DeviceError::Unavailable("the app hasn't started".into()))?;
        if op != "delete" {
            self.native.key_used(id.install_id);
        }
        let req = VoiceKeyRequest { op, id: id.account(), message: message.map(|m| B64.encode(m)) };
        tauri::async_runtime::spawn_blocking(move || app.k2_push().voice_key(req))
            .await
            .map_err(|e| DeviceError::Unavailable(format!("{op}: {e}")))?
            .map_err(|e| DeviceError::Unavailable(format!("{op}: {e}")))
    }
}

/// A SEC1 uncompressed P-256 public key (`04 ‖ x ‖ y`) from base64.
fn sec1(v: &Value) -> Result<Option<[u8; 65]>, DeviceError> {
    let Some(b64) = v.get("public").and_then(Value::as_str) else { return Ok(None) };
    let raw = B64.decode(b64).map_err(|_| DeviceError::Unavailable("public key: not base64".into()))?;
    let key: [u8; 65] = raw.try_into().map_err(|_| DeviceError::Unavailable("public key: not 65 bytes".into()))?;
    if key[0] != 4 {
        return Err(DeviceError::Unavailable("public key: not an uncompressed point".into()));
    }
    Ok(Some(key))
}

impl HardwareDeviceKey for EnclaveKey {
    fn public_key(&self, id: &DeviceKeyId) -> BoxFuture<'_, Result<Option<[u8; 65]>, DeviceError>> {
        let id = id.clone();
        Box::pin(async move { sec1(&self.call("public", &id, None).await?) })
    }

    fn generate(&self, id: &DeviceKeyId) -> BoxFuture<'_, Result<[u8; 65], DeviceError>> {
        let id = id.clone();
        Box::pin(async move {
            sec1(&self.call("generate", &id, None).await?)?
                .ok_or_else(|| DeviceError::Unavailable("generate answered no public key".into()))
        })
    }

    fn sign(&self, id: &DeviceKeyId, msg: &[u8]) -> BoxFuture<'_, Result<Vec<u8>, DeviceError>> {
        let id = id.clone();
        let msg = msg.to_vec();
        Box::pin(async move {
            let v = self.call("sign", &id, Some(&msg)).await?;
            let sig = v.get("signature").and_then(Value::as_str).unwrap_or_default();
            // The DER signature as iOS made it; the engine converts it.
            B64.decode(sig).map_err(|_| DeviceError::Unavailable("signature: not base64".into()))
        })
    }

    fn delete(&self, id: &DeviceKeyId) -> BoxFuture<'_, Result<(), DeviceError>> {
        let id = id.clone();
        Box::pin(async move { self.call("delete", &id, None).await.map(|_| ()) })
    }
}

// ── CallKit ──────────────────────────────────────────────────────────

enum ToShim {
    State(StateEvent),
    Muted(bool),
    /// The call has video (a camera or a screen share), or no longer.
    Video(bool),
    /// The next system call starts as a video call (a join with the camera),
    /// or not after all (that join failed).
    StartVideo(bool),
}

/// Engine → system call. The listener runs under the plugin's lock, so it
/// only queues; [`callkit_loop`] talks to Swift, in order.
struct CallKitBridge {
    tx: mpsc::Sender<ToShim>,
    native: Native,
    /// The call is held for a recording answer (`consent_required`): the
    /// notice that follows is the join's, not the call's.
    held: AtomicBool,
    /// The same events for [`watch_loop`] (the app in the background).
    watch: mpsc::Sender<Watched>,
}

/// The webview's consent sheet: Sew's notice in the kit's own words
/// (`null` once nothing waits for an answer).
pub const CONSENT_EVENT: &str = "k2-voice://consent";

/// The call has video or no longer (`video_changed`): the call screen's tile.
pub const VIDEO_EVENT: &str = "k2-voice://video";

impl VoiceListener for CallKitBridge {
    fn on_state(&self, state: &StateEvent) {
        self.held.store(matches!(state.state, CallState::ConsentRequired { .. }), Ordering::Relaxed);
        if matches!(state.state, CallState::Ended { .. } | CallState::Idle) {
            self.native.to_pip(ToSink::Ended);
        }
        let _ = self.tx.send(ToShim::State(state.clone()));
        self.native.note(&state_line(&state.state));
        let _ = self.watch.send(Watched::State(state.state.clone()));
        // After the note: the ring's own line follows the state's.
        self.native.screen_state(&state.state);
    }

    fn on_recording(&self, recording: Option<&RecordingInfo>) {
        self.native.note_recording(recording);
        let _ = self.watch.send(Watched::Recording(recording.cloned()));
        let ask = if self.held.load(Ordering::Relaxed) { ConsentAsk::Join } else { ConsentAsk::InCall };
        let sheet = recording.and_then(|r| consent_sheet(r, ask)).unwrap_or(Value::Null);
        // Emitting only queues: nothing here waits.
        if let Some(app) = self.native.app() {
            let _ = app.emit(CONSENT_EVENT, sheet);
        }
    }

    fn on_self_mute(&self, me: &SelfMute) {
        let _ = self.tx.send(ToShim::Muted(me.muted));
        self.native.note(if me.muted { "mute on" } else { "mute off" });
    }

    fn on_error(&self, error: &ErrorInfo) {
        self.native.note(&format!("error {}", code(&error.code)));
    }

    fn video_changed(&self, has_video: bool) {
        self.send_video(has_video);
        if let Some(app) = self.native.app() {
            let _ = app.emit(VIDEO_EVENT, has_video);
        }
        self.native.note(if has_video { "video on" } else { "video off" });
    }

    fn screen_share_changed(&self, active: bool) {
        self.native.screen_share(active);
    }
}

impl CallKitBridge {
    /// The call's video came or went: the system call and the speaker follow
    /// ([`show_video`]), and the picture in picture ([`pip_loop`]).
    fn send_video(&self, has_video: bool) {
        let _ = self.tx.send(ToShim::Video(has_video));
        self.native.to_pip(ToSink::Video(has_video));
    }
}

/// What the sheet shows, while this person still owes an answer.
fn consent_sheet(r: &RecordingInfo, ask: ConsentAsk) -> Option<Value> {
    // K2's own notice for its rooms (K2 0.46.11, as desktop's
    // recording-controls.ts): every room the phone joins is a K2 room, so
    // it's OK or leave, never Sew's per-person choices. The page words it
    // (voiceWire.ts recordingNoticeText) from these facts.
    let prompt: &ConsentPrompt = r.consent_prompt.as_ref().filter(|_| r.my_consent == "pending")?;
    let started_by = prompt.started_by.as_ref().map(|m| m.display_name.clone()).filter(|n| !n.is_empty());
    Some(json!({
        "ask": if ask == ConsentAsk::Join { "join" } else { "in_call" },
        "recordingId": r.recording_id,
        "noticeVersion": prompt.notice_version,
        "startedByName": started_by,
        "required": prompt.required,
        "audioKeepDays": prompt.audio_keep_days,
        "appReaders": prompt.app_readers,
        "agentReaders": prompt.agent_readers,
    }))
}

fn call_req(op: &str, f: impl FnOnce(&mut CallOpRequest)) -> CallOpRequest {
    let mut req = CallOpRequest { op: op.into(), ..Default::default() };
    f(&mut req);
    req
}

/// Where [`callkit_loop`] sends its `callOp`s: Swift, or a test's record.
trait CallOps {
    fn call_op(&mut self, op: &str, f: impl FnOnce(&mut CallOpRequest)) -> Option<Value>;
}

impl CallOps for Native {
    fn call_op(&mut self, op: &str, f: impl FnOnce(&mut CallOpRequest)) -> Option<Value> {
        let app = self.app()?;
        app.k2_push().call_op(call_req(op, f)).ok()
    }
}

fn callkit_loop(native: &mut impl CallOps, rx: mpsc::Receiver<ToShim>) {
    // Whether a system call is up (the shim's own `call`, as this side last made it).
    let mut up = false;
    // Whether the call has video, as the engine last said.
    let mut video = false;
    // The next start is a video call ([`join_with_camera`]).
    let mut start_video = false;
    for msg in rx {
        match msg {
            ToShim::State(ev) => match &ev.state {
                CallState::Connecting | CallState::Connected | CallState::Reconnecting { .. } => {
                    if !up {
                        // The first sign of a call: start the system call, which
                        // activates the audio session (kessel-audio waits for it).
                        let room = ev.room.clone();
                        let as_video = std::mem::take(&mut start_video);
                        let answer = native.call_op("start", |r| {
                            r.room = room;
                            r.video = as_video.then_some(true);
                        });
                        up = answer.as_ref().and_then(|v| v.get("ok")).and_then(Value::as_bool) == Some(true);
                        // Refused (another app's call, CallKit down): the shim
                        // emitted `start_failed`, and the engine leaves.
                        if !up {
                            continue;
                        }
                    }
                    let state = match ev.state {
                        CallState::Connected => "connected",
                        CallState::Reconnecting { .. } => "reconnecting",
                        _ => "connecting",
                    };
                    native.call_op("report", |r| {
                        r.state = Some(state.into());
                        r.video = Some(video);
                    });
                }
                // A re-join held for a recording answer: the call stays, waiting.
                CallState::ConsentRequired { .. } => {
                    if up {
                        native.call_op("report", |r| r.state = Some("reconnecting".into()));
                    }
                }
                CallState::Ended { reason } => {
                    if up {
                        let reason = reason.clone();
                        native.call_op("report", |r| {
                            r.state = Some("ended".into());
                            r.reason = Some(reason);
                        });
                        up = false;
                        video = false;
                    }
                }
                CallState::Idle => {
                    if up {
                        native.call_op("report", |r| {
                            r.state = Some("ended".into());
                            r.reason = Some("left".into());
                        });
                        up = false;
                        video = false;
                    }
                }
            },
            ToShim::Muted(muted) => {
                if up {
                    native.call_op("mute", |r| r.on = Some(muted));
                }
            }
            ToShim::StartVideo(on) => start_video = on,
            ToShim::Video(on) => {
                // Before the call is up, the first `report` carries it.
                if on != video {
                    video = on;
                    if up {
                        show_video(native, on);
                    }
                }
            }
        }
    }
}

/// Video came or went: the system call shows it (`hasVideo`), and the sound
/// moves as [`speaker_for`] says.
fn show_video(native: &mut impl CallOps, on: bool) {
    native.call_op("report", |r| r.video = Some(on));
    let now = native.call_op("route", |_| {}).unwrap_or(Value::Null);
    let route = now.get("route").and_then(Value::as_str).unwrap_or("other");
    let ours = now.get("autoSpeaker").and_then(Value::as_bool).unwrap_or(false);
    match speaker_for(route, on, ours) {
        Speaker::Override => native.call_op("autoSpeaker", |r| r.on = Some(true)),
        Speaker::Undo => native.call_op("autoSpeaker", |r| r.on = Some(false)),
        Speaker::Leave => None,
    };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Speaker {
    Override,
    Undo,
    Leave,
}

/// Where the sound goes when video changes. A video call held to the ear
/// makes no sense: the receiver becomes the speaker. Headphones, Bluetooth,
/// CarPlay and AirPlay are the person's pick and stay. Video off undoes only
/// an override video made (`ours`; the shim drops it on a route change).
/// `route` is the shim's `currentRoute()`.
fn speaker_for(route: &str, video: bool, ours: bool) -> Speaker {
    match (video, ours) {
        (true, false) if route == "receiver" => Speaker::Override,
        (false, true) => Speaker::Undo,
        _ => Speaker::Leave,
    }
}

/// System → engine: the shim's events (K2CallShim.swift, and K2PiP.swift's
/// `pip_…`), each on the async runtime or the PiP thread, never waiting here.
fn on_shim_event(control: &VoiceControl, native: &Native, event: &Value) {
    let c = control.clone();
    match event.get("event").and_then(Value::as_str).unwrap_or_default() {
        "end_requested" | "start_failed" => {
            tauri::async_runtime::spawn(async move {
                let _ = c.leave().await;
            });
        }
        "mute_requested" => {
            let muted = event.get("muted").and_then(Value::as_bool).unwrap_or(false);
            tauri::async_runtime::spawn(async move {
                let _ = c.set_muted(muted).await;
            });
        }
        "session_activated" => c.session_activated(),
        "session_deactivated" => c.session_deactivated(),
        "suspend" => c.suspend(),
        "resume" => c.resume(),
        // The audio server restarted: reopen the device as a route change does.
        "route_changed" | "media_reset" => c.route_changed(),
        "network_changed" => c.network_changed(),
        "app_scene" => {
            if let Some(scene) = scene_of(event) {
                c.app_scene(sew_scene(scene));
                native.to_pip(ToSink::Scene(scene));
            }
        }
        "pip_keyframe" => native.to_pip(ToSink::Keyframe),
        "pip_render_size" => {
            let px = |k| event.get(k).and_then(Value::as_u64).and_then(|v| u32::try_from(v).ok());
            if let (Some(w), Some(h)) = (px("width"), px("height")) {
                native.to_pip(ToSink::RenderSize(w, h));
            }
        }
        _ => {}
    }
}

/// The app on screen or not (the shim's `app_scene`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Scene {
    Background,
    Foreground,
}

fn scene_of(event: &Value) -> Option<Scene> {
    match event.get("scene").and_then(Value::as_str)? {
        "background" => Some(Scene::Background),
        "foreground" => Some(Scene::Foreground),
        _ => None,
    }
}

/// The app left the screen or came back, in Sew's words. Not
/// `suspend`/`resume`: those are audio interruptions, and the call goes on
/// here; only video changes (the webview's sinks stop, the PiP sink stays).
fn sew_scene(scene: Scene) -> AppScene {
    match scene {
        Scene::Background => AppScene::Background,
        Scene::Foreground => AppScene::Foreground,
    }
}

// ── Screen share (iPhone) ────────────────────────────────────────────
//
// iOS captures the screen only in a broadcast upload extension (K2Broadcast,
// gen/apple/K2Broadcast), started by the person from iOS's broadcast picker
// (the call bar's Share screen: `callOp broadcastPicker`). The extension
// writes raw NV12 frames into Sew's ring (kessel-frame-ring) in the App
// Group's container; the voice plugin reads, encodes, encrypts and
// publishes them as the call's screen. This side arms that ring once a call
// is connected (`VoiceControl::screen_share_ring`) and tells the call screen
// when the button can work (`armed`) and when the share runs (`active`, from
// `screen_share_changed`: it starts and stops outside the app). Stop is the
// webview's `screen {on: false}`; a call's end stops it in the plugin.

/// The screen share as the call screen shows it ([`ScreenView`]).
pub const SCREEN_EVENT: &str = "k2-voice://screen";

/// `armed`: the extension's ring is ready, so Share screen can open the
/// picker. `active`: this phone's screen is being shared.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
pub struct ScreenView {
    pub armed: bool,
    pub active: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum Ring {
    #[default]
    None,
    /// Arming (attempt n): the App Group's path and the plugin on their way.
    Arming(u64),
    Armed,
}

/// When to arm the ring: once per call, at its first `connected` (a
/// reconnect keeps it; the plugin removes it as the call ends). A failed arm
/// is tried again at the next `connected`. A re-join held for a recording
/// answer counts as a new call: its ring is armed again once it connects.
#[derive(Debug, Default)]
pub struct ScreenRing {
    ring: Ring,
    active: bool,
    attempts: u64,
}

impl ScreenRing {
    /// The call's state. `Some(attempt)`: arm the ring now.
    fn state(&mut self, s: &CallState) -> Option<u64> {
        match s {
            CallState::Connected if self.ring == Ring::None => {
                self.attempts += 1;
                self.ring = Ring::Arming(self.attempts);
                Some(self.attempts)
            }
            CallState::Ended { .. } | CallState::Idle | CallState::ConsentRequired { .. } => {
                self.ring = Ring::None;
                self.active = false;
                None
            }
            _ => None,
        }
    }

    /// Attempt `n`'s answer. Too late (the call ended, or a newer attempt
    /// runs): ignored.
    fn armed(&mut self, n: u64, ok: bool) {
        if self.ring == Ring::Arming(n) {
            self.ring = if ok { Ring::Armed } else { Ring::None };
        }
    }

    fn share(&mut self, active: bool) {
        self.active = active;
    }

    fn view(&self) -> ScreenView {
        ScreenView { armed: self.ring == Ring::Armed, active: self.active }
    }
}

/// The container path in Swift's `callOp appGroup` answer (`{ok, path}`).
fn app_group_of(answer: &Value) -> Option<PathBuf> {
    let path = answer.get("path").and_then(Value::as_str).filter(|p| !p.is_empty())?;
    Some(PathBuf::from(path))
}

impl Native {
    fn with_screen<T>(&self, f: impl FnOnce(&mut ScreenRing) -> T) -> (T, bool) {
        let mut ring = self.screen.lock().unwrap_or_else(|e| e.into_inner());
        let before = ring.view();
        let out = f(&mut ring);
        let changed = ring.view() != before;
        (out, changed)
    }

    fn emit_screen(&self) {
        let view = self.screen.lock().unwrap_or_else(|e| e.into_inner()).view();
        if let Some(app) = self.app() {
            let _ = app.emit(SCREEN_EVENT, view);
        }
    }

    /// The call's state: arm the ring at its first `connected`; the call
    /// screen hears when the button's state changes. Only queues: safe in a
    /// listener.
    fn screen_state(&self, s: &CallState) {
        let (arm, changed) = self.with_screen(|r| r.state(s));
        if changed {
            self.emit_screen();
        }
        if let Some(attempt) = arm {
            self.arm_screen_ring(attempt);
        }
    }

    /// The plugin's `screen_share_changed`.
    fn screen_share(&self, active: bool) {
        let ((), changed) = self.with_screen(|r| r.share(active));
        if changed {
            self.emit_screen();
        }
        self.note(if active { "screen share on" } else { "screen share off" });
    }

    /// The App Group's container, asked of Swift once. Blocks on Swift:
    /// never on the main thread or in a listener.
    fn app_group(&mut self) -> Option<PathBuf> {
        if let Some(p) = self.app_group.get() {
            return Some(p.clone());
        }
        let path = app_group_of(&self.call_op("appGroup", |_| {})?)?;
        let _ = self.app_group.set(path.clone());
        Some(path)
    }

    /// `screen_share_ring(<container>)`, on the async runtime (the listener
    /// that asked has returned by the time the plugin is called).
    fn arm_screen_ring(&self, attempt: u64) {
        let Some(app) = self.app() else { return };
        let native = self.clone();
        tauri::async_runtime::spawn(async move {
            let control = app.state::<VoiceControl>().inner().clone();
            let mut swift = native.clone();
            let dir = tauri::async_runtime::spawn_blocking(move || swift.app_group()).await.ok().flatten();
            let result = match dir {
                Some(dir) => control.screen_share_ring(dir).await.map_err(|e| e.code),
                None => Err("no_app_group".to_owned()),
            };
            native.note(&match &result {
                Ok(()) => "screen ring armed".to_owned(),
                Err(c) => format!("screen ring refused {}", code(c)),
            });
            let ((), changed) = native.with_screen(|r| r.armed(attempt, result.is_ok()));
            if changed {
                native.emit_screen();
            }
        });
    }
}

/// The screen share now, for a call screen opened after the event.
pub fn screen_view(native: &Native) -> Value {
    json!(native.screen.lock().unwrap_or_else(|e| e.into_inner()).view())
}

// ── Picture in picture ───────────────────────────────────────────────

/// What the PiP sink opens at: Sew's 360p layer.
const PIP_OPEN_SIZE: (u32, u32) = (640, 360);

/// The PiP window may ask for more, up to 720p (either way round), and never
/// less than 320 px on its long side.
const PIP_MAX: (u32, u32) = (1280, 720);
const PIP_MIN_LONG: u32 = 320;

/// What [`pip_loop`] hears, in order.
#[derive(Debug)]
enum ToSink {
    /// The call's video came or went (`video_changed`).
    Video(bool),
    /// The call ended.
    Ended,
    Scene(Scene),
    /// K2PiP's layer wants a keyframe (`pip_keyframe`).
    Keyframe,
    /// The PiP window's pixels (`pip_render_size`).
    RenderSize(u32, u32),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SinkAct {
    Open,
    Close,
    Keyframe,
    Resize(u32, u32),
}

/// When the PiP sink is open: while the call has video, on screen or not.
/// PiP's automatic start needs frames already playing inline when the app
/// leaves the screen, and Sew keeps this sink going in the background.
#[derive(Debug, Default)]
struct SinkPlan {
    video: bool,
    open: bool,
    /// The size last asked of the open sink.
    size: Option<(u32, u32)>,
}

impl SinkPlan {
    fn next(&mut self, msg: ToSink) -> Option<SinkAct> {
        match msg {
            ToSink::Video(on) => {
                self.video = on;
                self.want()
            }
            ToSink::Ended => {
                self.video = false;
                self.want()
            }
            // An open that failed (no window yet, say) tries again in front.
            ToSink::Scene(Scene::Foreground) => self.want(),
            ToSink::Scene(Scene::Background) => None,
            ToSink::Keyframe => self.open.then_some(SinkAct::Keyframe),
            ToSink::RenderSize(w, h) => {
                let size = pip_max_size(w, h)?;
                if !self.open || self.size == Some(size) {
                    return None;
                }
                Some(SinkAct::Resize(size.0, size.1))
            }
        }
    }

    fn want(&self) -> Option<SinkAct> {
        match (self.video, self.open) {
            (true, false) => Some(SinkAct::Open),
            (false, true) => Some(SinkAct::Close),
            _ => None,
        }
    }

    /// What `act` did (`ok`: an open opened).
    fn done(&mut self, act: SinkAct, ok: bool) {
        match act {
            SinkAct::Open => {
                self.open = ok;
                self.size = ok.then_some(PIP_OPEN_SIZE);
            }
            SinkAct::Close => {
                self.open = false;
                self.size = None;
            }
            SinkAct::Resize(w, h) => self.size = Some((w, h)),
            SinkAct::Keyframe => {}
        }
    }
}

/// The sink's `max_size` for a PiP window of `w`×`h` pixels: the window's
/// shape, within [`PIP_MAX`] and not under [`PIP_MIN_LONG`].
fn pip_max_size(w: u32, h: u32) -> Option<(u32, u32)> {
    if w == 0 || h == 0 {
        return None;
    }
    let (long, short) = (w.max(h) as f64, w.min(h) as f64);
    let mut scale = (PIP_MAX.0 as f64 / long).min(PIP_MAX.1 as f64 / short).min(1.0);
    if long * scale < PIP_MIN_LONG as f64 {
        scale = PIP_MIN_LONG as f64 / long;
    }
    let fit = |v: u32| ((v as f64 * scale).round() as u32).max(1);
    Some((fit(w), fit(h)))
}

/// What [`pip_loop`] does, so tests can stand in.
trait SinkOps {
    /// True when the sink opened.
    fn open(&mut self) -> bool;
    fn close(&mut self);
    fn keyframe(&mut self);
    fn resize(&mut self, w: u32, h: u32);
}

/// The PiP sink's own thread: [`VoiceControl`] can't be called from the
/// listener (it runs under the plugin's lock), so the listener and the shim
/// queue here.
fn pip_loop(ops: &mut impl SinkOps, rx: mpsc::Receiver<ToSink>) {
    let mut plan = SinkPlan::default();
    for msg in rx {
        let Some(act) = plan.next(msg) else { continue };
        let ok = match act {
            SinkAct::Open => ops.open(),
            SinkAct::Close => {
                ops.close();
                true
            }
            SinkAct::Keyframe => {
                ops.keyframe();
                true
            }
            SinkAct::Resize(w, h) => {
                ops.resize(w, h);
                true
            }
        };
        plan.done(act, ok);
    }
}

/// Sew's native sink on the active speaker, into K2PiP.
struct PipSink {
    native: Native,
    sink: Option<NativeSink>,
    counts: Arc<PipCounts>,
}

/// What the sink handed K2PiP, for the call log (counts only).
#[derive(Debug, Default)]
struct PipCounts {
    h264: AtomicU64,
    keyframes: AtomicU64,
    pixel_buffers: AtomicU64,
    /// Decoded frames as I420 / NV12 planes (the software VP8 decoder).
    i420: AtomicU64,
    nv12: AtomicU64,
    /// Decoded frames with no CVPixelBuffer (CPU planes): not shown.
    no_buffer: AtomicU64,
    discontinuities: AtomicU64,
    resets: AtomicU64,
    switches: AtomicU64,
}

impl PipCounts {
    fn count(&self, event: &NativeVideoEvent, feed: &[Feed<'_>]) {
        let add = |n: &AtomicU64| {
            n.fetch_add(1, Ordering::Relaxed);
        };
        match event {
            NativeVideoEvent::Frame(f) => {
                if f.keyframe {
                    add(&self.keyframes);
                }
                if f.discontinuity {
                    add(&self.discontinuities);
                }
                match feed.last() {
                    Some(Feed::H264 { .. }) => add(&self.h264),
                    Some(Feed::PixelBuffer { .. }) => add(&self.pixel_buffers),
                    Some(Feed::I420 { .. }) => add(&self.i420),
                    Some(Feed::Nv12 { .. }) => add(&self.nv12),
                    _ => add(&self.no_buffer),
                }
            }
            NativeVideoEvent::Reset { .. } => add(&self.resets),
            NativeVideoEvent::Switched { .. } => add(&self.switches),
            _ => {}
        }
    }

    fn line(&self) -> String {
        let n = |a: &AtomicU64| a.load(Ordering::Relaxed);
        format!(
            "pip frames h264={} keyframes={} pixel_buffers={} nv12={} i420={} no_buffer={} discontinuities={} resets={} switches={}",
            n(&self.h264),
            n(&self.keyframes),
            n(&self.pixel_buffers),
            n(&self.nv12),
            n(&self.i420),
            n(&self.no_buffer),
            n(&self.discontinuities),
            n(&self.resets),
            n(&self.switches)
        )
    }
}

impl SinkOps for PipSink {
    fn open(&mut self) -> bool {
        let Some(app) = self.native.app() else { return false };
        // The layer first: frames that come before it are dropped.
        let layer = self.native.call_op("pipLayer", |r| r.on = Some(true));
        if layer.as_ref().and_then(|v| v.get("ok")).and_then(Value::as_bool) != Some(true) {
            self.native.note("pip unavailable");
            return false;
        }
        let control = app.state::<VoiceControl>().inner().clone();
        self.counts = Arc::new(PipCounts::default());
        let feed = PipFeed { counts: self.counts.clone(), native: self.native.clone(), noted: Mutex::new(Instant::now()) };
        match control.open_native_sink(NativeSinkTarget::ActiveSpeaker, PIP_OPEN_SIZE, Arc::new(feed)) {
            Ok(sink) => {
                self.native.note("pip sink open");
                self.sink = Some(sink);
                true
            }
            Err(e) => {
                self.native.note(&format!("pip sink refused {}", code(&e.code)));
                self.native.call_op("pipLayer", |r| r.on = Some(false));
                false
            }
        }
    }

    fn close(&mut self) {
        // The sink first, so no frame races the layer's teardown.
        if let Some(sink) = self.sink.take() {
            sink.close();
        }
        *self.native.speaker.lock().unwrap_or_else(|e| e.into_inner()) = Value::Null;
        self.native.call_op("pipLayer", |r| r.on = Some(false));
        self.native.note(&self.counts.line());
        self.native.note("pip sink closed");
    }

    fn keyframe(&mut self) {
        if let Some(sink) = &self.sink {
            sink.request_keyframe();
        }
    }

    fn resize(&mut self, w: u32, h: u32) {
        if let Some(sink) = &self.sink {
            sink.set_max_size(w, h);
        }
    }
}

/// How often an open sink notes its counts in the call log.
const PIP_NOTE_EVERY: Duration = Duration::from_secs(30);

/// The sink's frames to K2PiP, on the sink's own thread. Swift copies each
/// one before returning.
struct PipFeed {
    counts: Arc<PipCounts>,
    native: Native,
    noted: Mutex<Instant>,
}

impl NativeVideoConsumer for PipFeed {
    fn on_video(&self, event: NativeVideoEvent) {
        if let Some(who) = speaker_of(&event) {
            self.native.note(&speaker_line(&who));
            *self.native.speaker.lock().unwrap_or_else(|e| e.into_inner()) = who.clone();
            if let Some(app) = self.native.app() {
                let _ = app.emit(PIP_SPEAKER_EVENT, who);
            }
        }
        let fed = feed(&event);
        self.counts.count(&event, &fed);
        {
            let mut noted = self.noted.lock().unwrap_or_else(|e| e.into_inner());
            if noted.elapsed() >= PIP_NOTE_EVERY {
                *noted = Instant::now();
                self.native.note(&self.counts.line());
            }
        }
        for f in fed {
            match f {
                Feed::Flush { remove_image } => pip::flush(remove_image),
                Feed::H264 { access_unit, pts_90k } => pip::h264(access_unit, pts_90k),
                Feed::PixelBuffer { buffer, pts_90k } => pip::pixel_buffer(buffer, pts_90k),
                Feed::Nv12 { frame, pts_90k } => pip::nv12(&frame, pts_90k),
                Feed::I420 { frame, pts_90k } => pip::i420(&frame, pts_90k),
            }
        }
    }
}

/// Whom the picture shows now (`{member_id, track}`, or `null`: no sink or
/// no switch yet), for a call screen that opened after the event.
pub fn pip_speaker(native: &Native) -> Value {
    native.speaker.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// The call log's line for a switch: which ids came, never the ids.
fn speaker_line(who: &Value) -> String {
    let has = |k: &str| if who.get(k).is_some_and(|v| !v.is_null()) { "yes" } else { "no" };
    format!("pip switched member={} track={}", has("member_id"), has("track"))
}

/// Whom the picture shows now (the active speaker the sink moved to), so
/// the call screen draws the layer on that person's tile: `{member_id,
/// track}`, both null when nobody is left to show.
pub const PIP_SPEAKER_EVENT: &str = "k2-voice://pip_speaker";

fn speaker_of(event: &NativeVideoEvent) -> Option<Value> {
    match event {
        NativeVideoEvent::Switched { track, member_id } => Some(json!({ "member_id": member_id, "track": track })),
        _ => None,
    }
}

/// What K2PiP gets for one of the sink's events.
#[derive(Debug, PartialEq)]
enum Feed<'a> {
    Flush { remove_image: bool },
    H264 { access_unit: &'a [u8], pts_90k: i64 },
    /// A decoded frame's CVPixelBufferRef, borrowed while the event lives.
    PixelBuffer { buffer: *mut std::ffi::c_void, pts_90k: i64 },
    /// A decoded frame's NV12 planes, borrowed while the event lives.
    Nv12 { frame: pip::Nv12<'a>, pts_90k: i64 },
    /// A decoded frame's I420 planes, borrowed while the event lives.
    I420 { frame: pip::I420<'a>, pts_90k: i64 },
}

fn feed(event: &NativeVideoEvent) -> Vec<Feed<'_>> {
    match event {
        NativeVideoEvent::Frame(f) => match &f.payload {
            payload => {
                // Arrival time, not the RTP clock: it keeps rising across a
                // switch to another sender.
                let pts_90k = pts_90k(f.timestamp_us);
                let unit = match payload {
                    NativePayload::H264 { access_unit, .. } => Feed::H264 { access_unit, pts_90k },
                    // VP8, decoded: a CVPixelBuffer, or (kessel-video's
                    // software VP8 decoder on iOS) CPU planes: NV12, which
                    // Sew's sink asks for, or I420.
                    _ => match (pixel_buffer(payload), nv12(payload), i420(payload)) {
                        (Some(buffer), _, _) => Feed::PixelBuffer { buffer, pts_90k },
                        (None, Some(frame), _) => Feed::Nv12 { frame, pts_90k },
                        (None, None, Some(frame)) => Feed::I420 { frame, pts_90k },
                        (None, None, None) => return Vec::new(),
                    },
                };
                if f.discontinuity {
                    vec![Feed::Flush { remove_image: false }, unit]
                } else {
                    vec![unit]
                }
            }
        },
        NativeVideoEvent::Reset { .. } => vec![Feed::Flush { remove_image: false }],
        // Nobody left to show: clear the picture too.
        NativeVideoEvent::Switched { track, .. } => vec![Feed::Flush { remove_image: track.is_none() }],
        _ => Vec::new(),
    }
}

/// A decoded frame's NV12 planes, checked against its size.
fn nv12(payload: &NativePayload) -> Option<pip::Nv12<'_>> {
    use sew_call_client::kessel_video::PixelFormat;
    let NativePayload::Decoded(f) = payload else { return None };
    let p = f.planes().filter(|p| p.format == PixelFormat::Nv12)?;
    let plane = |i: usize| -> Option<&[u8]> {
        let (row, rows) = PixelFormat::Nv12.plane_size(i, f.width, f.height);
        let len = (p.strides[i] as usize).checked_mul(rows.checked_sub(1)?)?.checked_add(row)?;
        p.data.get(p.offsets[i]..p.offsets[i].checked_add(len)?)
    };
    Some(pip::Nv12 {
        width: f.width,
        height: f.height,
        y: plane(0)?,
        uv: plane(1)?,
        stride_y: p.strides[0],
        stride_uv: p.strides[1],
    })
}

/// A decoded frame's I420 planes, checked against its size.
fn i420(payload: &NativePayload) -> Option<pip::I420<'_>> {
    use sew_call_client::kessel_video::PixelFormat;
    let NativePayload::Decoded(f) = payload else { return None };
    let p = f.planes().filter(|p| p.format == PixelFormat::I420)?;
    let plane = |i: usize| -> Option<&[u8]> {
        let (_, rows) = PixelFormat::I420.plane_size(i, f.width, f.height);
        let stride = p.strides[i] as usize;
        let start = p.offsets[i];
        // The last row needs only its width, not the whole stride.
        let (row, _) = PixelFormat::I420.plane_size(i, f.width, f.height);
        let len = stride.checked_mul(rows.checked_sub(1)?)?.checked_add(row)?;
        p.data.get(start..start.checked_add(len)?)
    };
    Some(pip::I420 {
        width: f.width,
        height: f.height,
        y: plane(0)?,
        u: plane(1)?,
        v: plane(2)?,
        stride_y: p.strides[0],
        stride_u: p.strides[1],
        stride_v: p.strides[2],
    })
}

/// A decoded frame's CVPixelBufferRef (Sew's `apple_pixel_buffer`).
fn pixel_buffer(payload: &NativePayload) -> Option<*mut std::ffi::c_void> {
    payload.apple_pixel_buffer().filter(|p| !p.is_null())
}

/// µs → the 90 kHz clock K2PiP stamps samples with.
fn pts_90k(us: u64) -> i64 {
    i64::try_from(us.saturating_mul(9) / 100).unwrap_or(i64::MAX)
}

// ── While the app is away ────────────────────────────────────────────

/// How long a re-join held for a recording answer waits for one before K2
/// leaves, so the system call doesn't say "Reconnecting…" for good.
const HELD_REJOIN_WAIT: Duration = Duration::from_secs(30);

/// The end reason of a call K2 left for that (Sew's own word for a notice
/// that went unanswered).
pub const CONSENT_TIMEOUT: &str = "recording_consent_timeout";

/// A join answered 404 `not_found`.
pub const ROOM_UNAVAILABLE: &str = "room_unavailable";

/// The end reason of a call K2 left because the system call (CallKit)
/// wouldn't start.
pub const SYSTEM_CALL_REFUSED: &str = "system_call_refused";

/// What the listener passes on to [`watch_loop`], in order.
enum Watched {
    State(CallState),
    Recording(Option<RecordingInfo>),
}

/// What [`watch_loop`] does next.
#[derive(Debug, PartialEq)]
enum Act {
    Notify { title: String, body: String },
    Unnotify,
    Leave,
    /// A new call: the last one's end reason is old news.
    Fresh,
}

/// The call as the background needs it: the recording notice's local
/// notification, and the held re-join's clock.
#[derive(Debug, Default)]
struct Watch {
    /// Past `connecting` (the call started).
    live: bool,
    /// The call got through once: a hold now is a re-join's.
    was_connected: bool,
    held: bool,
    leave_at: Option<Instant>,
    /// The last notice notified (recording id, notice version): never twice.
    notified: Option<(String, u32)>,
    /// A notification may be up.
    shown: bool,
}

impl Watch {
    fn state(&mut self, s: &CallState, now: Instant) -> Vec<Act> {
        if matches!(s, CallState::Ended { .. } | CallState::Idle) {
            let shown = std::mem::take(self).shown;
            return if shown { vec![Act::Unnotify] } else { Vec::new() };
        }
        let fresh = !std::mem::replace(&mut self.live, true);
        self.held = matches!(s, CallState::ConsentRequired { .. });
        if matches!(s, CallState::Connected) {
            self.was_connected = true;
        }
        if !self.held {
            self.leave_at = None;
        } else if self.was_connected && self.leave_at.is_none() {
            // A join held at the start is the person's to answer: no clock.
            self.leave_at = Some(now + HELD_REJOIN_WAIT);
        }
        if fresh { vec![Act::Fresh] } else { Vec::new() }
    }

    fn recording(&mut self, r: Option<&RecordingInfo>) -> Vec<Act> {
        let waiting = match (self.held, self.was_connected) {
            (false, _) => Waiting::InCall,
            (true, false) => Waiting::Join,
            (true, true) => Waiting::Rejoin,
        };
        match r.and_then(|r| recording_notice(r, waiting)) {
            Some(n) if self.notified.as_ref() == Some(&n.key) => Vec::new(),
            Some(n) => {
                self.notified = Some(n.key);
                self.shown = true;
                vec![Act::Notify { title: n.title, body: n.body }]
            }
            None if self.shown => {
                self.shown = false;
                vec![Act::Unnotify]
            }
            None => Vec::new(),
        }
    }

    fn tick(&mut self, now: Instant) -> Vec<Act> {
        match self.leave_at {
            Some(at) if self.held && now >= at => {
                self.leave_at = None;
                vec![Act::Leave]
            }
            _ => Vec::new(),
        }
    }
}

/// Who owes the answer, and what's at stake.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Waiting {
    /// A recording started in the call.
    InCall,
    /// The join is held (the person just asked to join).
    Join,
    /// The call's re-join is held: K2 leaves without an answer.
    Rejoin,
}

#[derive(Debug, PartialEq)]
struct Notice {
    key: (String, u32),
    title: String,
    body: String,
}

/// The local notification for a notice waiting on this person, in plain
/// words (the sheet itself has the kit's).
fn recording_notice(r: &RecordingInfo, waiting: Waiting) -> Option<Notice> {
    let prompt = r.consent_prompt.as_ref().filter(|_| r.my_consent == "pending")?;
    let what = Some(prompt.feature_label.trim()).filter(|l| !l.is_empty()).unwrap_or("A recorder");
    let call = match prompt.room.name.as_deref().map(str::trim) {
        Some(room) if !room.is_empty() => format!("the call in {room}"),
        _ => "the call".to_owned(),
    };
    let (title, body) = match waiting {
        Waiting::InCall => (
            "Recording started",
            // K2's rooms: OK or leave (K2 0.46.11), never "don't record me".
            format!("{what} is recording {call}. Open K2 to say OK or leave the call. You aren't recorded until you say OK."),
        ),
        Waiting::Join => (
            "This room is recorded",
            format!("{what} is recording {call}. Open K2 to say OK and join, or not join."),
        ),
        Waiting::Rejoin => (
            "Recording started",
            format!(
                "{what} started recording {call} while you were reconnecting. Open K2 to answer, \
                 or K2 leaves the call in {} seconds.",
                HELD_REJOIN_WAIT.as_secs()
            ),
        ),
    };
    Some(Notice { key: (r.recording_id.clone(), prompt.notice_version), title: title.to_owned(), body })
}

fn watch_thread(native: &Native) -> mpsc::Sender<Watched> {
    let (tx, rx) = mpsc::channel();
    let native = native.clone();
    std::thread::Builder::new()
        .name("k2-voice-watch".into())
        .spawn(move || watch_loop(&native, rx))
        .expect("the voice watch thread starts");
    tx
}

/// The listener's events, off its lock: the notification goes to Swift
/// (blocking), and a held re-join's clock runs here.
fn watch_loop(native: &Native, rx: mpsc::Receiver<Watched>) {
    let mut watch = Watch::default();
    loop {
        let next = match watch.leave_at {
            Some(at) => match rx.recv_timeout(at.saturating_duration_since(Instant::now())) {
                Ok(m) => Some(m),
                Err(mpsc::RecvTimeoutError::Timeout) => None,
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            },
            None => match rx.recv() {
                Ok(m) => Some(m),
                Err(_) => return,
            },
        };
        let acts = match next {
            Some(Watched::State(s)) => watch.state(&s, Instant::now()),
            Some(Watched::Recording(r)) => watch.recording(r.as_ref()),
            None => watch.tick(Instant::now()),
        };
        for act in acts {
            watch_act(native, act);
        }
    }
}

fn watch_act(native: &Native, act: Act) {
    let Some(app) = native.app() else { return };
    match act {
        Act::Notify { title, body } => {
            native.note("notice sent");
            let req = VoiceNoticeRequest { op: "post", title: Some(title), body: Some(body) };
            let _ = app.k2_push().voice_notice(req);
        }
        Act::Unnotify => {
            native.note("notice cleared");
            let _ = app.k2_push().voice_notice(VoiceNoticeRequest { op: "clear", title: None, body: None });
        }
        Act::Fresh => *native.ended_why.lock().unwrap_or_else(|e| e.into_inner()) = None,
        Act::Leave => {
            let control = app.state::<VoiceControl>().inner().clone();
            // Answered just now: nothing to give up.
            if !matches!(control.snapshot().state, CallState::ConsentRequired { .. }) {
                return;
            }
            native.note("leaving: held re-join unanswered");
            *native.ended_why.lock().unwrap_or_else(|e| e.into_inner()) = Some(CONSENT_TIMEOUT);
            tauri::async_runtime::spawn(async move {
                let _ = control.leave().await;
            });
        }
    }
}

/// Why the last call ended when K2 left it itself (the engine's `left`
/// would read as the person's own choice), else `None`.
pub fn ended_why(native: &Native) -> Option<&'static str> {
    *native.ended_why.lock().unwrap_or_else(|e| e.into_inner())
}

// ── The call log ─────────────────────────────────────────────────────

/// How many lines "Send call log" keeps.
const CALL_LOG_LINES: usize = 300;

/// The last call events, for "Send call log": states, error codes, the
/// system call's events, the join's outcome. Codes and numbers only
/// ([`code`]): never a token, a URL, a name or the notice's words.
#[derive(Debug, Default)]
pub struct CallLog {
    lines: VecDeque<String>,
    /// The last recording line (it repeats with every answer in the room).
    recording: Option<String>,
}

impl CallLog {
    fn push(&mut self, at_ms: u64, line: &str) {
        if self.lines.len() == CALL_LOG_LINES {
            self.lines.pop_front();
        }
        self.lines.push_back(format!("{} {line}", stamp(at_ms)));
    }

    fn push_recording(&mut self, at_ms: u64, line: String) {
        if self.recording.as_deref() != Some(&line) {
            self.push(at_ms, &line);
            self.recording = Some(line);
        }
    }

    /// The log as text, oldest first, under a header.
    pub fn text(&self, version: &str) -> String {
        let mut out = format!("K2 call log (K2 {}, iOS). Times are UTC.\n", code(version));
        if self.lines.is_empty() {
            out.push_str("No call events since K2 started.\n");
        }
        for l in &self.lines {
            out.push_str(l);
            out.push('\n');
        }
        out
    }
}

impl Native {
    /// One line in the call log.
    fn note(&self, line: &str) {
        self.log.lock().unwrap_or_else(|e| e.into_inner()).push(now_ms(), line);
    }

    fn note_recording(&self, r: Option<&RecordingInfo>) {
        let line = match r {
            Some(r) => format!("recording my_consent={} recorder_present={}", code(&r.my_consent), r.recorder_present),
            None => "recording none".to_owned(),
        };
        self.log.lock().unwrap_or_else(|e| e.into_inner()).push_recording(now_ms(), line);
    }
}

/// A line from the page (the kit's camera calls and `local_video`): words
/// as codes only, at most 6, so nothing but codes reaches the log.
pub fn note_from_page(native: &Native, words: &[String]) {
    let line: Vec<String> = words.iter().take(6).map(|w| code(w)).collect();
    if !line.is_empty() {
        native.note(&line.join(" "));
    }
}

/// The call log for "Send call log".
pub fn call_log_text(native: &Native, version: &str) -> String {
    native.log.lock().unwrap_or_else(|e| e.into_inner()).text(version)
}

/// A code as the log keeps it: `[a-z0-9_.:-]`, short, and nothing shaped
/// like a secret (a credential, or a long unbroken run like a token: the
/// rule [`clean`] keeps for refusals).
fn code(s: &str) -> String {
    let c: String = s
        .chars()
        .filter_map(|ch| match ch {
            'a'..='z' | '0'..='9' | '_' | '.' | ':' | '-' => Some(ch),
            'A'..='Z' => Some(ch.to_ascii_lowercase()),
            _ => None,
        })
        .take(48)
        .collect();
    let secret = c.contains("sewcc_") || c.split(['_', '.', ':', '-']).any(|w| w.len() >= 16);
    if secret {
        "redacted".to_owned()
    } else if c.is_empty() {
        "none".to_owned()
    } else {
        c
    }
}

fn state_line(s: &CallState) -> String {
    match s {
        CallState::Idle => "state idle".to_owned(),
        CallState::Connecting => "state connecting".to_owned(),
        CallState::Connected => "state connected".to_owned(),
        CallState::Reconnecting { attempt } => format!("state reconnecting attempt={attempt}"),
        CallState::ConsentRequired { notice_version, .. } => format!("state consent_required notice={notice_version}"),
        CallState::Ended { reason } => format!("state ended reason={}", code(reason)),
    }
}

/// A shim event (K2CallShim.swift): its name and the fields worth knowing.
fn shim_line(event: &Value) -> String {
    let mut line = format!("system {}", code(event.get("event").and_then(Value::as_str).unwrap_or_default()));
    for key in ["why", "route", "interface", "error"] {
        if let Some(v) = event.get(key).and_then(Value::as_str) {
            line.push_str(&format!(" {key}={}", code(v)));
        }
    }
    if let Some(m) = event.get("muted").and_then(Value::as_bool) {
        line.push_str(&format!(" muted={m}"));
    }
    line
}

/// A provider answer for the log.
fn outcome(e: Option<&ProviderError>) -> String {
    match e {
        None => "ok".to_owned(),
        Some(ProviderError::SigninRequired) => "signin_required".to_owned(),
        Some(ProviderError::Refused { code: c, .. }) => format!("refused {}", code(c)),
        Some(ProviderError::Unavailable { .. }) => "unavailable".to_owned(),
        Some(ProviderError::ConsentRequired(_)) => "consent_required".to_owned(),
        Some(_) => "failed".to_owned(),
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// `2026-11-05 14:03:22.123` (UTC).
fn stamp(ms: u64) -> String {
    let secs = ms / 1000;
    let (h, m, s) = (secs / 3600 % 24, secs / 60 % 60, secs % 60);
    // Days to a civil date (Howard Hinnant's `civil_from_days`).
    let z = (secs / 86_400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02} {h:02}:{m:02}:{s:02}.{:03}", ms % 1000)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(notice: Option<Value>) -> JoinRequest {
        let mut v = json!({ "target": "s1", "room": "room-1", "muted": false, "deafened": true, "rejoin": null });
        if let Some(n) = notice {
            v["recording_notice"] = n;
        }
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn join_body_carries_the_recording_answer() {
        let plain = join_body(&req(None));
        assert_eq!(plain, json!({ "room": "room-1", "join": { "call_credential": true, "self_mute": true, "self_deaf": true } }));
        let notice = json!({ "recording_id": "77", "consent": true, "notice_version": 3 });
        let held = join_body(&req(Some(notice.clone())));
        assert_eq!(held["join"]["recording_notice"], notice);
    }

    /// Sew's contract fixture (`recording.held.recording`, 0.8.0).
    fn held() -> RecordingInfo {
        serde_json::from_value(held_json()).unwrap()
    }

    fn held_json() -> Value {
        json!({
            "recording_id": "48831765147549720", "auto": false, "started_by": "1001", "my_consent": "pending",
            "consent_prompt": {
                "recording_id": "48831765147549720", "notice_version": 3141, "recorder_name": "Sew Notes",
                "feature_label": "Sew Notes", "started_by": { "member_id": "1001", "display_name": "Alice" },
                "room": { "channel_id": "48831765147549698", "kind": "voice", "name": "lounge" },
                "audio_keep_days": 30,
                "transcript": { "posted_to_channel": true, "readable_by": ["channel_members"], "e2ee": false },
                "admin_download": true, "decline_mode": "join_unrecorded", "recorded_now": ["1001"]
            },
            "participants": [], "recorder_present": false
        })
    }

    /// K2's `POST /cli/voice/recording/consent` answers (K2 main 9543a6d24).
    #[test]
    fn consent_answers() {
        // Sew's `Recording.min` fixture, inside K2's answer.
        let rec = json!({
            "audio_keep_days": 0, "auto": true, "channel_id": "48831765147549711", "id": "48831765147550202",
            "max_duration_ms": 14400000, "message_id": "48831765147549701", "mixed": false, "participants": [],
            "started_at": "2026-09-27T12:00:00.123Z", "started_by": "48831765147549699", "state": "starting"
        });
        let ok = json!({ "ok": true, "recordingId": "48831765147550202", "consent": true, "recording": rec });
        assert!(consent_from(200, None, ok.to_string().as_bytes(), "tok").is_ok());
        assert!(consent_from(200, None, rec.to_string().as_bytes(), "tok").is_ok());
        // A changed notice: Sew's refusal inside K2's, read as Sew's.
        let sew = json!({ "code": "conflict", "details": {
            "reason": "recording_consent_required", "consent_prompt": held_json()["consent_prompt"], "auto": false
        } });
        let changed = json!({ "ok": false, "error": { "code": "consent_notice_changed", "hint": "",
            "details": { "consent_prompt": held_json()["consent_prompt"], "recording": null, "sew": sew } } });
        match consent_from(409, None, changed.to_string().as_bytes(), "tok") {
            Err(ProviderError::ConsentRequired(c)) => assert_eq!(c.notice_version(), 3141),
            other => panic!("{other:?}"),
        }
        let code = |status, body: Value| match consent_from(status, None, body.to_string().as_bytes(), "tok") {
            Err(ProviderError::Refused { code, .. }) => code,
            other => panic!("{other:?}"),
        };
        let k2 = |c: &str| json!({ "ok": false, "error": { "code": c, "hint": "" } });
        assert_eq!(code(404, k2("recording_not_found")), "recording_not_found");
        assert_eq!(code(422, k2("recording_not_active")), "recording_not_active");
        assert_eq!(code(404, json!(null)), tauri_plugin_sew_voice::CONSENT_UNSUPPORTED);
    }

    #[test]
    fn consent_sheet_carries_k2s_notice_facts() {
        let sheet = consent_sheet(&held(), ConsentAsk::Join).unwrap();
        assert_eq!(sheet["ask"], "join");
        assert_eq!(sheet["noticeVersion"], 3141);
        assert_eq!(sheet["startedByName"], "Alice", "{sheet}");
        assert!(sheet["audioKeepDays"].is_number() && sheet["appReaders"].is_array(), "{sheet}");
        assert!(sheet["required"].is_boolean() && sheet["agentReaders"].is_boolean(), "{sheet}");
        assert!(sheet.get("choices").is_none(), "K2's notice is OK or leave, worded by the page");
        let in_call = consent_sheet(&held(), ConsentAsk::InCall).unwrap();
        assert_eq!(in_call["ask"], "in_call");
        // Answered: nothing to show.
        let mut granted = held();
        granted.my_consent = "granted".into();
        assert!(consent_sheet(&granted, ConsentAsk::InCall).is_none());
    }

    fn rec_req(v: Value) -> RecordingRequest {
        serde_json::from_value(v).expect("a RecordingRequest")
    }

    #[test]
    fn record_and_stop_go_to_k2s_routes() {
        let start = rec_req(json!({ "target": "s1", "room": "standup", "action": "start" }));
        let (route, body) = recording_body(&start).unwrap();
        assert_eq!((route, body), ("recording/start", json!({ "room": "standup" })));
        let stop = rec_req(json!({ "target": "s1", "room": "standup", "action": "stop", "recording_id": "48831765147549720" }));
        let (route, body) = recording_body(&stop).unwrap();
        assert_eq!((route, body), ("recording/stop", json!({ "recordingId": "48831765147549720" })));
        let nothing = rec_req(json!({ "target": "s1", "room": "standup", "action": "stop" }));
        assert!(matches!(recording_body(&nothing), Err(ProviderError::Refused { code, .. }) if code == "no_recording"));
    }

    #[test]
    fn a_k2_without_the_record_route_is_unsupported_and_a_refusal_keeps_sews_reason() {
        let r = recording_answer_from(404, None, b"", "tok", RECORDING_UNSUPPORTED);
        assert!(matches!(r, Err(ProviderError::Refused { ref code, .. }) if code == RECORDING_UNSUPPORTED), "{r:?}");
        let body = json!({ "error": { "code": "recording_active", "message": "already" } }).to_string();
        let r = recording_answer_from(409, None, body.as_bytes(), "tok", RECORDING_UNSUPPORTED);
        assert!(matches!(r, Err(ProviderError::Refused { ref code, .. }) if code == "recording_active"), "{r:?}");
    }

    fn held_at(version: u32) -> CallState {
        CallState::ConsentRequired { recording_id: "48831765147549720".into(), notice_version: version }
    }

    #[test]
    fn a_held_rejoin_is_left_after_30_seconds_and_a_held_join_is_not() {
        let t0 = Instant::now();
        let mut w = Watch::default();
        // Held at the start: the person is looking at the sheet.
        assert_eq!(w.state(&CallState::Connecting, t0), vec![Act::Fresh]);
        assert!(w.state(&held_at(3141), t0).is_empty());
        assert_eq!(w.leave_at, None);
        assert!(w.tick(t0 + Duration::from_secs(600)).is_empty());
        // Answered, connected, then a recording starts during a re-join.
        assert!(w.state(&CallState::Connected, t0).is_empty());
        assert!(w.state(&CallState::Reconnecting { attempt: 1 }, t0).is_empty());
        assert!(w.state(&held_at(3141), t0).is_empty());
        assert_eq!(w.leave_at, Some(t0 + HELD_REJOIN_WAIT));
        // A newer notice keeps the clock.
        assert!(w.state(&held_at(3142), t0 + Duration::from_secs(10)).is_empty());
        assert!(w.tick(t0 + Duration::from_secs(29)).is_empty());
        assert_eq!(w.tick(t0 + Duration::from_secs(30)), vec![Act::Leave]);
        assert!(w.tick(t0 + Duration::from_secs(31)).is_empty(), "once");
        // Answered in time: no leave.
        let mut w = Watch::default();
        w.state(&CallState::Connected, t0);
        w.state(&held_at(3141), t0);
        w.state(&CallState::Connected, t0 + Duration::from_secs(5));
        assert!(w.tick(t0 + Duration::from_secs(60)).is_empty());
        // A call that ended forgets it was connected: the next call's first hold is a join's.
        w.state(&CallState::Ended { reason: "left".into() }, t0);
        assert_eq!(w.state(&CallState::Connecting, t0), vec![Act::Fresh]);
        w.state(&held_at(1), t0);
        assert_eq!(w.leave_at, None);
    }

    #[test]
    fn the_recording_notice_is_notified_once_and_taken_away() {
        let t0 = Instant::now();
        let mut w = Watch::default();
        w.state(&CallState::Connected, t0);
        let acts = w.recording(Some(&held()));
        let [Act::Notify { title, body }] = acts.as_slice() else { panic!("{acts:?}") };
        assert_eq!(title, "Recording started");
        assert!(body.contains("Sew Notes is recording the call in lounge"), "{body}");
        // The same notice again (another member answered): not twice.
        assert!(w.recording(Some(&held())).is_empty());
        // Answered: the notification goes.
        let mut granted = held();
        granted.my_consent = "granted".into();
        assert_eq!(w.recording(Some(&granted)), vec![Act::Unnotify]);
        assert!(w.recording(None).is_empty());
        // A new version of the notice is news.
        let mut newer = held();
        newer.consent_prompt.as_mut().unwrap().notice_version = 3142;
        assert!(matches!(w.recording(Some(&newer)).as_slice(), [Act::Notify { .. }]));
        // The call ends: the notification goes with it.
        assert_eq!(w.state(&CallState::Ended { reason: "left".into() }, t0), vec![Act::Unnotify]);
        assert!(w.state(&CallState::Idle, t0).is_empty());
        // A held re-join says what happens without an answer.
        let mut w = Watch::default();
        w.state(&CallState::Connected, t0);
        w.state(&held_at(3141), t0);
        let acts = w.recording(Some(&held()));
        let [Act::Notify { body, .. }] = acts.as_slice() else { panic!("{acts:?}") };
        assert!(body.contains("leaves the call in 30 seconds"), "{body}");
        // A held first join.
        let mut w = Watch::default();
        w.state(&held_at(3141), t0);
        let acts = w.recording(Some(&held()));
        let [Act::Notify { title, .. }] = acts.as_slice() else { panic!("{acts:?}") };
        assert_eq!(title, "This room is recorded");
    }

    #[test]
    fn the_call_log_keeps_codes_and_the_last_300_lines() {
        assert_eq!(code("credential_lost"), "credential_lost");
        assert_eq!(code("callkit: 1"), "callkit:1");
        assert_eq!(code("Bearer sewcc_abc"), "redacted");
        assert_eq!(code("k2d_9f8e7d6c5b4a39281706"), "redacted");
        assert_eq!(code("https://a.example/x?t=1"), "https:a.examplext1");
        assert_eq!(code(""), "none");
        assert_eq!(stamp(0), "1970-01-01 00:00:00.000");
        assert_eq!(stamp(1_793_196_202_123), "2026-10-28 14:03:22.123");
        assert_eq!(stamp(951_782_400_000), "2000-02-29 00:00:00.000");
        assert_eq!(state_line(&CallState::Ended { reason: "recording_consent_timeout".into() }), "state ended reason=recording_consent_timeout");
        assert_eq!(state_line(&held_at(7)), "state consent_required notice=7");
        let ev = json!({ "event": "start_failed", "error": "callkit: 3", "call": "UUID-1", "token": "tok" });
        assert_eq!(shim_line(&ev), "system start_failed error=callkit:3");
        assert_eq!(shim_line(&json!({ "event": "mute_requested", "muted": true })), "system mute_requested muted=true");
        assert_eq!(outcome(Some(&refused("room_full", "x"))), "refused room_full");
        assert_eq!(outcome(Some(&ProviderError::Other("https://a.example".into()))), "failed");

        let mut log = CallLog::default();
        for i in 0..(CALL_LOG_LINES + 5) {
            log.push(0, &format!("line {i}"));
        }
        let text = log.text("4.2.0");
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines[0], "K2 call log (K2 4.2.0, iOS). Times are UTC.");
        assert_eq!(lines.len(), CALL_LOG_LINES + 1);
        assert_eq!(lines[1], "1970-01-01 00:00:00.000 line 5");
        // A recording line that didn't change isn't repeated.
        let mut log = CallLog::default();
        log.push_recording(0, "recording my_consent=pending recorder_present=true".into());
        log.push_recording(0, "recording my_consent=pending recorder_present=true".into());
        assert_eq!(log.lines.len(), 1);
        assert!(CallLog::default().text("4.2.0").contains("No call events"));
    }

    #[test]
    fn a_removed_servers_install_is_forgotten_once_no_server_uses_it() {
        let mut i = Installs::default();
        assert!(i.saw(7, "a"));
        assert!(!i.saw(7, "a"));
        i.saw(7, "b"); // two logins on one box
        i.saw(9, "c");
        assert_eq!(i.prune(&|s| s != "a"), Vec::<u64>::new());
        assert_eq!(i.prune(&|s| s == "c"), vec![7]);
        assert_eq!(i.0.keys().cloned().collect::<Vec<_>>(), vec!["9".to_owned()]);
        let json = serde_json::to_string(&i).unwrap();
        assert_eq!(serde_json::from_str::<Installs>(&json).unwrap(), i);
    }

    /// The shim as the loop sees it: every `callOp` it got, and a route.
    struct FakeShim {
        ops: Vec<Value>,
        route: &'static str,
        auto: bool,
    }

    impl CallOps for FakeShim {
        fn call_op(&mut self, op: &str, f: impl FnOnce(&mut CallOpRequest)) -> Option<Value> {
            let req = call_req(op, f);
            self.ops.push(json!(req));
            match op {
                "route" => Some(json!({ "ok": true, "route": self.route, "autoSpeaker": self.auto })),
                "autoSpeaker" => {
                    self.auto = req.on == Some(true);
                    Some(json!({ "ok": true }))
                }
                _ => Some(json!({ "ok": true })),
            }
        }
    }

    fn run(route: &'static str, msgs: Vec<ToShim>) -> Vec<Value> {
        let (tx, rx) = mpsc::channel();
        for m in msgs {
            tx.send(m).unwrap();
        }
        drop(tx);
        let mut shim = FakeShim { ops: Vec::new(), route, auto: false };
        callkit_loop(&mut shim, rx);
        shim.ops
    }

    fn state(s: CallState) -> ToShim {
        ToShim::State(StateEvent::bare(s))
    }

    #[test]
    fn video_on_the_system_call_and_the_speaker() {
        let ops = run(
            "receiver",
            vec![
                state(CallState::Connected),
                ToShim::Video(true),
                ToShim::Video(true),
                ToShim::Video(false),
                state(CallState::Ended { reason: "left".into() }),
            ],
        );
        assert_eq!(
            ops,
            vec![
                json!({ "op": "start" }),
                json!({ "op": "report", "state": "connected", "video": false }),
                json!({ "op": "report", "video": true }),
                json!({ "op": "route" }),
                json!({ "op": "autoSpeaker", "on": true }),
                json!({ "op": "report", "video": false }),
                json!({ "op": "route" }),
                json!({ "op": "autoSpeaker", "on": false }),
                json!({ "op": "report", "state": "ended", "reason": "left" }),
            ]
        );
    }

    #[test]
    fn a_join_with_the_camera_starts_a_video_call_and_your_camera_takes_the_speaker() {
        let ops = run(
            "receiver",
            vec![
                ToShim::StartVideo(true),
                state(CallState::Connecting),
                state(CallState::Connected),
                // Your own camera turned on once connected: Sew's `video_changed`.
                ToShim::Video(true),
                state(CallState::Ended { reason: "left".into() }),
                // The next call is a plain one again.
                state(CallState::Connecting),
            ],
        );
        assert_eq!(
            ops,
            vec![
                json!({ "op": "start", "video": true }),
                json!({ "op": "report", "state": "connecting", "video": false }),
                json!({ "op": "report", "state": "connected", "video": false }),
                json!({ "op": "report", "video": true }),
                json!({ "op": "route" }),
                json!({ "op": "autoSpeaker", "on": true }),
                json!({ "op": "report", "state": "ended", "reason": "left" }),
                json!({ "op": "start" }),
                json!({ "op": "report", "state": "connecting", "video": false }),
            ]
        );
        // A camera join that failed before the call started: a plain start next.
        let ops = run("speaker", vec![ToShim::StartVideo(true), ToShim::StartVideo(false), state(CallState::Connecting)]);
        assert_eq!(ops[0], json!({ "op": "start" }));
    }

    #[test]
    fn video_before_the_call_rides_its_first_report_and_ends_with_it() {
        let ops = run(
            "headphones",
            vec![
                ToShim::Video(true),
                state(CallState::Connecting),
                state(CallState::Idle),
                state(CallState::Connecting),
                ToShim::Video(true),
            ],
        );
        assert_eq!(
            ops,
            vec![
                json!({ "op": "start" }),
                json!({ "op": "report", "state": "connecting", "video": true }),
                json!({ "op": "report", "state": "ended", "reason": "left" }),
                json!({ "op": "start" }),
                json!({ "op": "report", "state": "connecting", "video": false }),
                // Headphones: the route stays.
                json!({ "op": "report", "video": true }),
                json!({ "op": "route" }),
            ]
        );
    }

    #[test]
    fn the_speaker_moves_only_from_the_receiver_and_back_only_if_ours() {
        use Speaker::*;
        assert_eq!(speaker_for("receiver", true, false), Override);
        for route in ["speaker", "headphones", "bluetooth", "carplay", "airplay", "other"] {
            assert_eq!(speaker_for(route, true, false), Leave, "{route}");
        }
        assert_eq!(speaker_for("speaker", true, true), Leave);
        assert_eq!(speaker_for("speaker", false, true), Undo);
        // The person took the speaker themselves, or the route moved on.
        assert_eq!(speaker_for("speaker", false, false), Leave);
        assert_eq!(speaker_for("receiver", false, false), Leave);
    }

    #[test]
    fn a_switch_is_logged_without_its_ids() {
        assert_eq!(speaker_line(&json!({ "member_id": "55769769701277696", "track": "TR_x" })), "pip switched member=yes track=yes");
        assert_eq!(speaker_line(&json!({ "member_id": null, "track": "TR_x" })), "pip switched member=no track=yes");
        assert_eq!(speaker_line(&json!({ "member_id": null, "track": null })), "pip switched member=no track=no");
    }

    #[test]
    fn scene_events() {
        assert_eq!(scene_of(&json!({ "event": "app_scene", "scene": "background" })), Some(Scene::Background));
        assert_eq!(scene_of(&json!({ "event": "app_scene", "scene": "foreground" })), Some(Scene::Foreground));
        assert_eq!(scene_of(&json!({ "event": "app_scene", "scene": "inactive" })), None);
        assert_eq!(scene_of(&json!({ "event": "app_scene" })), None);
        assert_eq!(sew_scene(Scene::Background), AppScene::Background);
        assert_eq!(sew_scene(Scene::Foreground), AppScene::Foreground);
    }

    /// The PiP sink as the loop sees it: what it was asked, and whether
    /// opens work.
    #[derive(Default)]
    struct FakeSink {
        acts: Vec<SinkAct>,
        refuse: bool,
    }

    impl SinkOps for FakeSink {
        fn open(&mut self) -> bool {
            self.acts.push(SinkAct::Open);
            !self.refuse
        }
        fn close(&mut self) {
            self.acts.push(SinkAct::Close);
        }
        fn keyframe(&mut self) {
            self.acts.push(SinkAct::Keyframe);
        }
        fn resize(&mut self, w: u32, h: u32) {
            self.acts.push(SinkAct::Resize(w, h));
        }
    }

    fn pip_run(sink: &mut FakeSink, msgs: Vec<ToSink>) -> Vec<SinkAct> {
        let (tx, rx) = mpsc::channel();
        for m in msgs {
            tx.send(m).unwrap();
        }
        drop(tx);
        pip_loop(sink, rx);
        std::mem::take(&mut sink.acts)
    }

    #[test]
    fn the_pip_sink_is_open_while_the_call_has_video() {
        use SinkAct::*;
        let mut sink = FakeSink::default();
        let acts = pip_run(
            &mut sink,
            vec![
                // Nothing to ask of a closed sink.
                ToSink::Keyframe,
                ToSink::RenderSize(1280, 720),
                ToSink::Video(true),
                ToSink::Video(true),
                // The background keeps it: that's where PiP is.
                ToSink::Scene(Scene::Background),
                ToSink::Keyframe,
                ToSink::RenderSize(1920, 1080),
                ToSink::RenderSize(1920, 1080),
                ToSink::Scene(Scene::Foreground),
                ToSink::Video(false),
                ToSink::Keyframe,
                ToSink::Video(true),
                // The call ends: closed even before video says so.
                ToSink::Ended,
                ToSink::Video(false),
                ToSink::Ended,
            ],
        );
        assert_eq!(acts, vec![Open, Keyframe, Resize(1280, 720), Close, Open, Close]);
    }

    #[test]
    fn a_refused_pip_open_tries_again_in_front() {
        use SinkAct::*;
        let mut sink = FakeSink { refuse: true, ..FakeSink::default() };
        let mut plan = SinkPlan::default();
        let (tx, rx) = mpsc::channel();
        for m in [ToSink::Video(true), ToSink::Keyframe, ToSink::Scene(Scene::Background)] {
            tx.send(m).unwrap();
        }
        drop(tx);
        pip_loop(&mut sink, rx);
        assert_eq!(std::mem::take(&mut sink.acts), vec![Open]);
        // The same refusal, step by step: back on screen it tries again.
        assert_eq!(plan.next(ToSink::Video(true)), Some(Open));
        plan.done(Open, false);
        assert_eq!(plan.next(ToSink::Keyframe), None);
        assert_eq!(plan.next(ToSink::Scene(Scene::Background)), None);
        assert_eq!(plan.next(ToSink::Scene(Scene::Foreground)), Some(Open));
        plan.done(Open, true);
        assert_eq!(plan.next(ToSink::Scene(Scene::Foreground)), None);
        // Once video is gone, nothing to retry.
        assert_eq!(plan.next(ToSink::Ended), Some(Close));
        plan.done(Close, true);
        assert_eq!(plan.next(ToSink::Scene(Scene::Foreground)), None);
    }

    #[test]
    fn the_pip_window_size_becomes_the_sinks_max_size() {
        assert_eq!(pip_max_size(640, 360), Some((640, 360)));
        assert_eq!(pip_max_size(1920, 1080), Some((1280, 720)));
        // A portrait window keeps its shape.
        assert_eq!(pip_max_size(1080, 1920), Some((720, 1280)));
        assert_eq!(pip_max_size(1000, 1000), Some((720, 720)));
        assert_eq!(pip_max_size(160, 90), Some((320, 180)));
        assert_eq!(pip_max_size(0, 360), None);
        // The size it opened at isn't asked again.
        let mut plan = SinkPlan::default();
        assert_eq!(plan.next(ToSink::Video(true)), Some(SinkAct::Open));
        plan.done(SinkAct::Open, true);
        assert_eq!(plan.next(ToSink::RenderSize(640, 360)), None);
        assert_eq!(plan.next(ToSink::RenderSize(0, 0)), None);
    }

    fn h264(keyframe: bool, discontinuity: bool) -> NativeVideoEvent {
        NativeVideoEvent::Frame(tauri_plugin_sew_voice::native::NativeVideoFrame {
            track: "TR_v1".into(),
            keyframe,
            discontinuity,
            timestamp_us: 2_000_000,
            rtp_ts: 7,
            payload: NativePayload::H264 { access_unit: vec![0, 0, 0, 1, 0x65, 9], width: 640, height: 360 },
        })
    }

    #[test]
    fn a_decoded_i420_frame_goes_to_k2pip_as_planes() {
        use sew_call_client::kessel_video::{Planes, PixelFormat, VideoFrame};
        // 4x2 I420, Y stride 8 (padded rows), chroma 2x1 tight.
        let mut data = vec![0u8; 16 + 2 + 2];
        data[0] = 11;
        data[16] = 22;
        data[18] = 33;
        let planes = Planes::new(PixelFormat::I420, 4, 2, data, [8, 2, 2], [0, 16, 18]).unwrap();
        let frame = VideoFrame::from_planes(planes, 4, 2, 0).unwrap();
        let event = NativeVideoEvent::Frame(tauri_plugin_sew_voice::native::NativeVideoFrame {
            track: "TR_v2".into(),
            keyframe: true,
            discontinuity: false,
            timestamp_us: 1_000_000,
            rtp_ts: 1,
            payload: NativePayload::Decoded(frame),
        });
        let fed = feed(&event);
        let [Feed::I420 { frame, pts_90k }] = fed.as_slice() else { panic!("{fed:?}") };
        assert_eq!(*pts_90k, 90_000);
        assert_eq!((frame.width, frame.height, frame.stride_y, frame.stride_u), (4, 2, 8, 2));
        // Y: one full stride plus the last row's width.
        assert_eq!((frame.y.len(), frame.y[0]), (12, 11));
        assert_eq!((frame.u, frame.v), (&[22u8, 0][..], &[33u8, 0][..]));
        let counts = PipCounts::default();
        counts.count(&event, &fed);
        assert!(counts.line().contains("nv12=0 i420=1 no_buffer=0"), "{}", counts.line());
    }

    #[test]
    fn page_notes_are_codes_only() {
        let words = |w: &[&str]| w.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let line: Vec<String> = words(&["camera", "Permission", "granted", "sewcc_abcdefghijklmnopqrstu"]).iter().map(|w| code(w)).collect();
        assert_eq!(line.join(" "), "camera permission granted redacted");
    }

    #[test]
    fn a_decoded_nv12_frame_goes_to_k2pip_as_planes() {
        use sew_call_client::kessel_video::{Planes, PixelFormat, VideoFrame};
        // 4x2 NV12, Y stride 4, UV stride 4 (2 CbCr pairs, 1 row).
        let mut data = vec![0u8; 8 + 4];
        data[0] = 7;
        data[8] = 128;
        data[9] = 64;
        let planes = Planes::new(PixelFormat::Nv12, 4, 2, data, [4, 4, 0], [0, 8, 0]).unwrap();
        let frame = VideoFrame::from_planes(planes, 4, 2, 0).unwrap();
        let event = NativeVideoEvent::Frame(tauri_plugin_sew_voice::native::NativeVideoFrame {
            track: "TR_v2".into(),
            keyframe: true,
            discontinuity: false,
            timestamp_us: 2_000_000,
            rtp_ts: 1,
            payload: NativePayload::Decoded(frame),
        });
        let fed = feed(&event);
        let [Feed::Nv12 { frame, pts_90k }] = fed.as_slice() else { panic!("{fed:?}") };
        assert_eq!(*pts_90k, 180_000);
        assert_eq!((frame.width, frame.height, frame.stride_y, frame.stride_uv), (4, 2, 4, 4));
        assert_eq!((frame.y.len(), frame.y[0]), (8, 7));
        assert_eq!(frame.uv, &[128u8, 64, 0, 0][..]);
        let counts = PipCounts::default();
        counts.count(&event, &fed);
        assert!(counts.line().contains("nv12=1 i420=0 no_buffer=0"), "{}", counts.line());
    }

    #[test]
    fn the_sinks_events_to_k2pip() {
        let unit: &[u8] = &[0, 0, 0, 1, 0x65, 9];
        let frame = h264(false, false);
        assert_eq!(feed(&frame), vec![Feed::H264 { access_unit: unit, pts_90k: 180_000 }]);
        // A discontinuity flushes first.
        let first = h264(true, true);
        assert_eq!(
            feed(&first),
            vec![Feed::Flush { remove_image: false }, Feed::H264 { access_unit: unit, pts_90k: 180_000 }]
        );
        assert_eq!(feed(&NativeVideoEvent::Reset { track: "TR_v1".into() }), vec![Feed::Flush { remove_image: false }]);
        let to = NativeVideoEvent::Switched { track: Some("TR_v2".into()), member_id: Some("1001".into()) };
        assert_eq!(feed(&to), vec![Feed::Flush { remove_image: false }]);
        let nobody = NativeVideoEvent::Switched { track: None, member_id: None };
        assert_eq!(feed(&nobody), vec![Feed::Flush { remove_image: true }]);
        // Whom the picture shows, for the call screen's tile.
        assert_eq!(speaker_of(&to), Some(json!({ "member_id": "1001", "track": "TR_v2" })));
        assert_eq!(speaker_of(&nobody), Some(json!({ "member_id": null, "track": null })));
        assert_eq!(speaker_of(&frame), None);
        assert_eq!(pts_90k(1_000_000), 90_000);

        // The call log's counts.
        let counts = PipCounts::default();
        for e in [&first, &frame, &to, &nobody] {
            counts.count(e, &feed(e));
        }
        let reset = NativeVideoEvent::Reset { track: "TR_v1".into() };
        counts.count(&reset, &feed(&reset));
        assert_eq!(
            counts.line(),
            "pip frames h264=2 keyframes=1 pixel_buffers=0 nv12=0 i420=0 no_buffer=0 discontinuities=1 resets=1 switches=2"
        );
    }

    #[test]
    fn refusals() {
        let ended = br#"{"ok":false,"error":{"code":"device_session_ended","hint":"pair again"}}"#;
        match answer_from(403, None, ended, "https://a.example", "tok") {
            Err(ProviderError::Refused { code, .. }) => assert_eq!(code, "device_session_ended"),
            other => panic!("{other:?}"),
        }
        assert!(matches!(answer_from(401, None, b"{}", "https://a.example", "tok"), Err(ProviderError::SigninRequired)));
        let old_k2 = br#"{"ok":false,"error":{"code":"not_found","hint":"no such route"}}"#;
        match answer_from(404, None, old_k2, "https://a.example", "tok") {
            Err(ProviderError::Refused { code, .. }) => assert_eq!(code, ROOM_UNAVAILABLE),
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            answer_from(503, Some(2), b"", "https://a.example", "tok"),
            Err(ProviderError::Unavailable { retry_after_ms: Some(2000) })
        ));
        let leaky = br#"{"error":{"code":"x","hint":"Bearer tok-123"}}"#;
        match answer_from(400, None, leaky, "https://a.example", "tok-123") {
            Err(ProviderError::Refused { detail, .. }) => assert_eq!(detail, json!({ "hint": null, "details": null })),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn the_screen_ring_is_armed_once_per_call_at_its_first_connected() {
        let mut r = ScreenRing::default();
        let ended = CallState::Ended { reason: "left".into() };
        assert_eq!(r.view(), ScreenView { armed: false, active: false });
        // Connecting: nothing to arm yet (the plugin refuses before the call is up).
        assert_eq!(r.state(&CallState::Connecting), None);
        assert_eq!(r.state(&CallState::Connected), Some(1));
        // Arming: a second `connected` doesn't arm twice.
        assert_eq!(r.state(&CallState::Connected), None);
        assert!(!r.view().armed);
        r.armed(1, true);
        assert_eq!(r.view(), ScreenView { armed: true, active: false });
        // A reconnect keeps the ring (arming again would end a running share).
        assert_eq!(r.state(&CallState::Reconnecting { attempt: 1 }), None);
        assert_eq!(r.state(&CallState::Connected), None);
        assert!(r.view().armed);
        // The extension's first frame: the share runs; the call ends: all off.
        r.share(true);
        assert_eq!(r.view(), ScreenView { armed: true, active: true });
        assert_eq!(r.state(&ended), None);
        assert_eq!(r.view(), ScreenView { armed: false, active: false });
        // The next call arms afresh.
        assert_eq!(r.state(&CallState::Connected), Some(2));
    }

    #[test]
    fn a_late_or_failed_arm_never_marks_the_ring_ready() {
        let mut r = ScreenRing::default();
        assert_eq!(r.state(&CallState::Connected), Some(1));
        // Refused (no App Group, `screen_unsupported`): the next `connected` tries again.
        r.armed(1, false);
        assert!(!r.view().armed);
        assert_eq!(r.state(&CallState::Reconnecting { attempt: 1 }), None);
        assert_eq!(r.state(&CallState::Connected), Some(2));
        // The call ended while attempt 2 was on its way: its answer is too late.
        assert_eq!(r.state(&CallState::Idle), None);
        r.armed(2, true);
        assert!(!r.view().armed);
        // A newer attempt's call ignores an older answer.
        assert_eq!(r.state(&CallState::Connected), Some(3));
        r.armed(2, true);
        assert!(!r.view().armed);
        r.armed(3, true);
        assert!(r.view().armed);
        // A re-join held for a recording answer is a new call: armed again once it connects.
        assert_eq!(r.state(&held_at(1)), None);
        assert!(!r.view().armed);
        assert_eq!(r.state(&CallState::Connected), Some(4));
    }

    #[test]
    fn the_screen_view_as_the_call_screen_reads_it() {
        assert_eq!(json!(ScreenView { armed: true, active: false }), json!({ "armed": true, "active": false }));
        assert_eq!(
            app_group_of(&json!({ "ok": true, "path": "/private/var/mobile/Containers/Shared/AppGroup/X" })),
            Some(PathBuf::from("/private/var/mobile/Containers/Shared/AppGroup/X"))
        );
        assert_eq!(app_group_of(&json!({ "ok": false, "error": "no_app_group" })), None);
        assert_eq!(app_group_of(&json!({ "ok": true, "path": "" })), None);
    }
}
