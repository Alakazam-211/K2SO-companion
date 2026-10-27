//! Desktop no-op backend: push is mobile-only, so `is_available()` is
//! always false and the rest errors gracefully (the dormant contract —
//! nothing here can crash or prompt).

use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<K2Push<R>> {
    Ok(K2Push(app.clone()))
}

/// Access to the k2-push APIs (desktop fallback).
pub struct K2Push<R: Runtime>(#[allow(dead_code)] AppHandle<R>);

impl<R: Runtime> K2Push<R> {
    pub fn is_available(&self) -> crate::Result<Availability> {
        Ok(Availability {
            available: false,
            platform: "desktop".into(),
            reason: Some("push notifications are mobile-only".into()),
        })
    }

    pub fn request_permission(&self) -> crate::Result<PermissionResponse> {
        Err(crate::Error::Unavailable("desktop build".into()))
    }

    pub fn get_token(&self) -> crate::Result<TokenResponse> {
        Err(crate::Error::Unavailable("desktop build".into()))
    }

    pub fn get_launch_tap(&self) -> crate::Result<LaunchTapResponse> {
        Ok(LaunchTapResponse { tap: None })
    }

    pub fn cache_avatars(&self, _req: CacheAvatarsRequest) -> crate::Result<CacheAvatarsResponse> {
        Ok(CacheAvatarsResponse {
            available: false,
            written: 0,
            skipped: 0,
            failed: 0,
            reason: Some("notification avatars are iOS-only".into()),
        })
    }

    pub fn e2e_op(&self, _req: E2eOpRequest) -> crate::Result<serde_json::Value> {
        Ok(serde_json::json!({ "available": false, "reason": "e2e push keys are iOS only" }))
    }

    pub fn set_server_totals(&self, _req: ServerTotalsRequest) -> crate::Result<BadgeSumResponse> {
        Ok(BadgeSumResponse::unavailable(BADGE_IOS_ONLY))
    }

    pub fn clear_server_totals(
        &self,
        _req: ClearServerTotalsRequest,
    ) -> crate::Result<BadgeSumResponse> {
        Ok(BadgeSumResponse::unavailable(BADGE_IOS_ONLY))
    }

    pub fn get_badge_totals(&self) -> crate::Result<BadgeTotalsResponse> {
        Ok(BadgeTotalsResponse::unavailable(BADGE_IOS_ONLY))
    }

    pub fn get_badge_diagnostics(&self) -> crate::Result<BadgeDiagnosticsResponse> {
        Ok(BadgeDiagnosticsResponse::unavailable(BADGE_IOS_ONLY))
    }

    pub async fn pick_media(&self, _req: PickRequest) -> crate::Result<PickResponse> {
        Err(crate::Error::Unsupported(PICKERS_IOS_ONLY.into()))
    }

    pub async fn pick_documents(&self, _req: PickRequest) -> crate::Result<PickResponse> {
        Err(crate::Error::Unsupported(PICKERS_IOS_ONLY.into()))
    }

    pub async fn scan_qr(&self) -> crate::Result<ScanQrResponse> {
        Err(crate::Error::Unsupported(PICKERS_IOS_ONLY.into()))
    }
}

const BADGE_IOS_ONLY: &str = "app-icon badge totals are iOS-only";
const PICKERS_IOS_ONLY: &str = "native attach pickers are iOS-only";
