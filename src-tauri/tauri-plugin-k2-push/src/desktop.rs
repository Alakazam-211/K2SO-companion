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
}
