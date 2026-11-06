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
//!
//! Avatars (`cache_avatars`): iOS Communication Notifications. JS hands
//! over each workspace's icon (`{key, rev, dataUrl}`); Swift writes a
//! 128px PNG into the App Group container where the Notification
//! Service Extension (`gen/apple/K2NotificationService`) reads it. No
//! App Group entitlement → the command answers `available: false`.
//!
//! Badge (`set_server_totals`, `clear_server_totals`, `get_badge_totals`,
//! `get_badge_diagnostics`): iOS app-icon badge = the sum of each server's
//! unread total, kept in the App Group (`K2BadgeStore.swift`, shared with
//! the NSE), keyed by the push's `badgeKey` (K2 0.46.1) else `subdomain`;
//! the set/clear commands take `{key}` (`{subdomain}` still accepted).
//! Event `badgeTotals` `{key, subdomain?, badgeKey?, unread, waiting?, sum}` when
//! a silent `{kind:"badge"}` push (or a foreground alert push) brings new
//! totals. Android/desktop: stubs that answer `available: false`.
//!
//! Attach pickers (`pick_media`, `pick_documents`): the composer's own
//! attach menu opens the photo library (PHPicker) or the document picker
//! directly, so iOS's file-input menu never shows (`K2Pickers.swift`).
//! Resolve `{files: [{name, mime, base64}], skipped, cancelled}`. Android
//! and desktop reject `unsupported: …`; JS uses the web file input there.

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

/// Picture in Picture's frames (K2PiP.swift's `@_cdecl` entry points), not
/// through `run_mobile_plugin`: called on Sew's native sink thread, never
/// the main one. Swift copies before it returns. No-ops off iOS.
pub mod pip {
    #[cfg(target_os = "ios")]
    extern "C" {
        fn k2_pip_h264(bytes: *const u8, len: usize, pts_90k: i64);
        fn k2_pip_flush(remove_image: bool);
        fn k2_pip_pixel_buffer(buffer: *mut std::ffi::c_void, pts_90k: i64);
        fn k2_pip_nv12(width: u32, height: u32, y: *const u8, stride_y: u32, uv: *const u8, stride_uv: u32, pts_90k: i64);
        #[allow(clippy::too_many_arguments)]
        fn k2_pip_i420(
            width: u32,
            height: u32,
            y: *const u8,
            stride_y: u32,
            u: *const u8,
            stride_u: u32,
            v: *const u8,
            stride_v: u32,
            pts_90k: i64,
        );
    }

    /// One decoded NV12 frame's planes, borrowed.
    #[derive(Debug, PartialEq)]
    pub struct Nv12<'a> {
        pub width: u32,
        pub height: u32,
        pub y: &'a [u8],
        pub uv: &'a [u8],
        pub stride_y: u32,
        pub stride_uv: u32,
    }

    /// One decoded NV12 frame (what Sew's native sink asks the VP8 decoder
    /// for): Swift copies it into a pooled pixel buffer before returning.
    pub fn nv12(frame: &Nv12<'_>, pts_90k: i64) {
        #[cfg(target_os = "ios")]
        // SAFETY: the planes outlive the call; Swift reads them during it.
        unsafe {
            k2_pip_nv12(
                frame.width,
                frame.height,
                frame.y.as_ptr(),
                frame.stride_y,
                frame.uv.as_ptr(),
                frame.stride_uv,
                pts_90k,
            )
        }
        #[cfg(not(target_os = "ios"))]
        let _ = (frame, pts_90k);
    }

    /// One decoded I420 frame's planes, borrowed.
    #[derive(Debug, PartialEq)]
    pub struct I420<'a> {
        pub width: u32,
        pub height: u32,
        pub y: &'a [u8],
        pub u: &'a [u8],
        pub v: &'a [u8],
        pub stride_y: u32,
        pub stride_u: u32,
        pub stride_v: u32,
    }

    /// One decoded I420 frame (the software VP8 decoder): Swift copies it
    /// into an NV12 pixel buffer before returning.
    pub fn i420(frame: &I420<'_>, pts_90k: i64) {
        #[cfg(target_os = "ios")]
        // SAFETY: the planes outlive the call; Swift reads them during it.
        unsafe {
            k2_pip_i420(
                frame.width,
                frame.height,
                frame.y.as_ptr(),
                frame.stride_y,
                frame.u.as_ptr(),
                frame.stride_u,
                frame.v.as_ptr(),
                frame.stride_v,
                pts_90k,
            )
        }
        #[cfg(not(target_os = "ios"))]
        let _ = (frame, pts_90k);
    }

    /// One H.264 access unit, Annex B. `pts_90k` only orders frames.
    pub fn h264(access_unit: &[u8], pts_90k: i64) {
        #[cfg(target_os = "ios")]
        // SAFETY: Swift reads `len` bytes during the call and keeps nothing.
        unsafe {
            k2_pip_h264(access_unit.as_ptr(), access_unit.len(), pts_90k)
        }
        #[cfg(not(target_os = "ios"))]
        let _ = (access_unit, pts_90k);
    }

    /// One decoded frame: a CVPixelBufferRef, borrowed for the call (Swift
    /// retains it before returning).
    pub fn pixel_buffer(buffer: *mut std::ffi::c_void, pts_90k: i64) {
        #[cfg(target_os = "ios")]
        // SAFETY: the caller's frame keeps `buffer` alive during the call;
        // Swift takes its own retain.
        unsafe {
            k2_pip_pixel_buffer(buffer, pts_90k)
        }
        #[cfg(not(target_os = "ios"))]
        let _ = (buffer, pts_90k);
    }

    /// A break in the stream: the layer drops what it holds and waits for a
    /// keyframe. `remove_image` when there's nothing left to show.
    pub fn flush(remove_image: bool) {
        #[cfg(target_os = "ios")]
        // SAFETY: no arguments to keep.
        unsafe {
            k2_pip_flush(remove_image)
        }
        #[cfg(not(target_os = "ios"))]
        let _ = remove_image;
    }
}

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
            commands::cache_avatars,
            commands::set_server_totals,
            commands::clear_server_totals,
            commands::clear_delivered,
            commands::get_badge_totals,
            commands::get_badge_diagnostics,
            commands::e2e_op,
            commands::call_op,
            commands::token_op,
            commands::pick_media,
            commands::pick_documents,
            commands::scan_qr,
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
