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
//!
//! The webview drives joins through the plugin's own commands
//! (`plugin:sew-voice|join` …) and follows its `sew-voice://` events.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, OnceLock, RwLock};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde_json::{json, Value};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_k2_push::{CallOpRequest, K2PushExt, VoiceKeyRequest, VoiceWatchRequest};
use tauri_plugin_sew_voice::sew_call_client::Recording;
use tauri_plugin_sew_voice::{
    BoxFuture, CallState, ConsentAnswer, DeviceError, DeviceKeyId, HardwareDeviceKey, JoinAnswer,
    JoinProvider, JoinRequest, ProviderError, RecordingInfo, SelfMute, StateEvent, VoiceControl, VoiceListener,
};
use tauri_plugin_sew_voice::{ConsentAsk, ConsentPrompt};

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
    let bridge_native = native.clone();
    std::thread::Builder::new()
        .name("k2-callkit".into())
        .spawn(move || callkit_loop(&bridge_native, rx))
        .expect("the CallKit thread starts");
    tauri_plugin_sew_voice::Builder::new(K2Provider::new(native.clone()))
        .listener(Arc::new(CallKitBridge { tx, native: native.clone(), held: AtomicBool::new(false) }))
        .hardware_device_key(Arc::new(EnclaveKey { native: native.clone() }))
        .build()
}

/// After the plugins are up: the native handle, and the call shim's events
/// into the engine.
pub fn start(app: &AppHandle<Wry>, native: &Native) {
    let _ = native.app.set(app.clone());
    let control = app.state::<VoiceControl>().inner().clone();
    let channel = Channel::new(move |body: InvokeResponseBody| {
        if let InvokeResponseBody::Json(text) = body {
            if let Ok(event) = serde_json::from_str::<Value>(&text) {
                on_shim_event(&control, &event);
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
}

/// What the daemon answered a recording answer with, as the plugin's types.
pub fn consent_from(status: u16, retry_after_secs: Option<u64>, body: &[u8], token: &str) -> Result<Recording, ProviderError> {
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
        (404 | 405, _) => Err(refused(tauri_plugin_sew_voice::CONSENT_UNSUPPORTED, "this server can't take a recording answer yet")),
        _ => Err(clean(ProviderError::from_sew_error(status, retry_after_secs.map(|s| s * 1000), body), token)),
    }
}

impl JoinProvider for K2Provider {
    fn join(&self, req: JoinRequest) -> BoxFuture<'_, Result<JoinAnswer, ProviderError>> {
        Box::pin(self.join_inner(req))
    }

    fn consent(&self, answer: ConsentAnswer) -> BoxFuture<'_, Result<Recording, ProviderError>> {
        Box::pin(self.consent_inner(answer))
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
}

/// Engine → system call. The listener runs under the plugin's lock, so it
/// only queues; [`callkit_loop`] talks to Swift, in order.
struct CallKitBridge {
    tx: mpsc::Sender<ToShim>,
    native: Native,
    /// The call is held for a recording answer (`consent_required`): the
    /// notice that follows is the join's, not the call's.
    held: AtomicBool,
}

/// The webview's consent sheet: Sew's notice in the kit's own words
/// (`null` once nothing waits for an answer).
pub const CONSENT_EVENT: &str = "k2-voice://consent";

impl VoiceListener for CallKitBridge {
    fn on_state(&self, state: &StateEvent) {
        self.held.store(matches!(state.state, CallState::ConsentRequired { .. }), Ordering::Relaxed);
        let _ = self.tx.send(ToShim::State(state.clone()));
    }

    fn on_recording(&self, recording: Option<&RecordingInfo>) {
        let ask = if self.held.load(Ordering::Relaxed) { ConsentAsk::Join } else { ConsentAsk::InCall };
        let sheet = recording.and_then(|r| consent_sheet(r, ask)).unwrap_or(Value::Null);
        // Emitting only queues: nothing here waits.
        if let Some(app) = self.native.app() {
            let _ = app.emit(CONSENT_EVENT, sheet);
        }
    }

    fn on_self_mute(&self, me: &SelfMute) {
        let _ = self.tx.send(ToShim::Muted(me.muted));
    }
}

/// What the sheet shows, while this person still owes an answer.
fn consent_sheet(r: &RecordingInfo, ask: ConsentAsk) -> Option<Value> {
    let prompt: &ConsentPrompt = r.consent_prompt.as_ref().filter(|_| r.my_consent == "pending")?;
    let starter = prompt.started_by.clone();
    let name = move |id| match &starter {
        Some(m) if m.member_id == id => m.display_name.clone(),
        _ => "someone".to_owned(),
    };
    let choices: Vec<Value> =
        prompt.choices_en(ask).iter().map(|c| json!({ "label": c.label, "granted": c.granted })).collect();
    Some(json!({
        "ask": if ask == ConsentAsk::Join { "join" } else { "in_call" },
        "noticeVersion": prompt.notice_version,
        "title": prompt.title_en(ask),
        "text": prompt.text_en(ask, &name),
        "choices": choices,
    }))
}

fn call_op(native: &Native, op: &str, f: impl FnOnce(&mut CallOpRequest)) -> Option<Value> {
    let app = native.app()?;
    let mut req = CallOpRequest { op: op.into(), room: None, server: None, state: None, reason: None, on: None, title: None };
    f(&mut req);
    app.k2_push().call_op(req).ok()
}

fn callkit_loop(native: &Native, rx: mpsc::Receiver<ToShim>) {
    // Whether a system call is up (the shim's own `call`, as this side last made it).
    let mut up = false;
    for msg in rx {
        match msg {
            ToShim::State(ev) => match &ev.state {
                CallState::Connecting | CallState::Connected | CallState::Reconnecting { .. } => {
                    if !up {
                        // The first sign of a call: start the system call, which
                        // activates the audio session (kessel-audio waits for it).
                        let room = ev.room.clone();
                        let answer = call_op(native, "start", |r| r.room = room);
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
                    call_op(native, "report", |r| r.state = Some(state.into()));
                }
                // A re-join held for a recording answer: the call stays, waiting.
                CallState::ConsentRequired { .. } => {
                    if up {
                        call_op(native, "report", |r| r.state = Some("reconnecting".into()));
                    }
                }
                CallState::Ended { reason } => {
                    if up {
                        let reason = reason.clone();
                        call_op(native, "report", |r| {
                            r.state = Some("ended".into());
                            r.reason = Some(reason);
                        });
                        up = false;
                    }
                }
                CallState::Idle => {
                    if up {
                        call_op(native, "report", |r| {
                            r.state = Some("ended".into());
                            r.reason = Some("left".into());
                        });
                        up = false;
                    }
                }
            },
            ToShim::Muted(muted) => {
                if up {
                    call_op(native, "mute", |r| r.on = Some(muted));
                }
            }
        }
    }
}

/// System → engine: the shim's events (K2CallShim.swift), each on the
/// async runtime, never waiting here.
fn on_shim_event(control: &VoiceControl, event: &Value) {
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
        _ => {}
    }
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
    fn consent_sheet_in_the_kits_words() {
        let sheet = consent_sheet(&held(), ConsentAsk::Join).unwrap();
        assert_eq!(sheet["ask"], "join");
        assert_eq!(sheet["noticeVersion"], 3141);
        assert!(sheet["text"].as_str().unwrap().contains("Alice"), "{sheet}");
        let labels: Vec<_> = sheet["choices"].as_array().unwrap().iter().map(|c| c["label"].clone()).collect();
        assert_eq!(labels, vec![json!("Join and allow recording"), json!("Join without being recorded"), json!("Cancel")]);
        assert_eq!(sheet["choices"][2]["granted"], Value::Null);
        let in_call = consent_sheet(&held(), ConsentAsk::InCall).unwrap();
        assert_eq!(in_call["choices"][1]["label"], "Don't record me");
        // Answered: nothing to show.
        let mut granted = held();
        granted.my_consent = "granted".into();
        assert!(consent_sheet(&granted, ConsentAsk::InCall).is_none());
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

    #[test]
    fn refusals() {
        let ended = br#"{"ok":false,"error":{"code":"device_session_ended","hint":"pair again"}}"#;
        match answer_from(403, None, ended, "https://a.example", "tok") {
            Err(ProviderError::Refused { code, .. }) => assert_eq!(code, "device_session_ended"),
            other => panic!("{other:?}"),
        }
        assert!(matches!(answer_from(401, None, b"{}", "https://a.example", "tok"), Err(ProviderError::SigninRequired)));
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
}
