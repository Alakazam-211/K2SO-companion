//! tauri-plugin-k2-push — Companion C6 (prd-companion-v2 §4; feedback
//! PRD §8.1/§8.2). Native APNs/FCM device-token plumbing + tap deep-link
//! events for the K2 Companion.
//!
//! DORMANT-FIRST contract: this plugin must compile, load and run in a
//! build with NO push provisioning (no `aps-environment` entitlement,
//! no `google-services.json`, no Firebase gradle plugin). Every layer
//! feature-detects:
//!
//! - **Desktop / dev**: `is_available()` = false ("mobile-only"),
//!   everything else errors gracefully — no native layer exists.
//! - **iOS without the entitlement**: `registerForRemoteNotifications`
//!   fails fast (error 3000 "no valid aps-environment") → the Swift
//!   side reports unavailable. Registration never prompts the user
//!   (only `request_permission` does, and JS only calls that once the
//!   availability probe passed AND the Settings toggle is on).
//! - **Android without Firebase config**: `FirebaseApp.getApps()` is
//!   empty → the Kotlin side reports unavailable; the
//!   FirebaseMessagingService is manifest-registered but FCM never
//!   starts it without an initialized default app.
//!
//! Events (`addPluginListener("k2-push", ...)`):
//! - `tokenRefresh` `{token, platform}` — vendor rotated the device
//!   token; JS re-runs register-device.
//! - `tap` `{kind, feedbackId?|groupId?, subdomain?}` — the user tapped
//!   a push notification; JS navigates. Taps that launched the app cold
//!   are buffered natively and drained via `get_launch_tap()`.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod commands;
mod error;
mod models;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

pub use error::{Error, Result};
pub use models::*;

#[cfg(desktop)]
use desktop::K2Push;
#[cfg(mobile)]
use mobile::K2Push;

/// Access the k2-push APIs from Rust (`app.k2_push()`).
pub trait K2PushExt<R: Runtime> {
    fn k2_push(&self) -> &K2Push<R>;
}

impl<R: Runtime, T: Manager<R>> K2PushExt<R> for T {
    fn k2_push(&self) -> &K2Push<R> {
        self.state::<K2Push<R>>().inner()
    }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("k2-push")
        .invoke_handler(tauri::generate_handler![
            commands::is_available,
            commands::request_permission,
            commands::get_token,
            commands::get_launch_tap,
        ])
        .setup(|app, api| {
            #[cfg(mobile)]
            let k2_push = mobile::init(app, api)?;
            #[cfg(desktop)]
            let k2_push = desktop::init(app, api)?;
            app.manage(k2_push);
            Ok(())
        })
        .build()
}
