//! Mobile backend: registers the Swift (`K2PushPlugin.swift`) / Kotlin
//! (`K2PushPlugin.kt`) native halves and proxies commands to them. All
//! dormancy detection lives natively; this layer only adds the
//! "availability probe must never error" guarantee.

use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::*;

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.alakazamlabs.k2so.push";

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_k2_push);

// initializes the Kotlin or Swift plugin classes
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<K2Push<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "K2PushPlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_k2_push)?;
    Ok(K2Push(handle))
}

/// Access to the k2-push APIs (mobile).
pub struct K2Push<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> K2Push<R> {
    /// Never errors: a native failure IS the "unavailable" answer (the
    /// dormant build must never surface a probe as a crash/rejection).
    pub fn is_available(&self) -> crate::Result<Availability> {
        Ok(self
            .0
            .run_mobile_plugin::<Availability>("isAvailable", ())
            .unwrap_or_else(|e| Availability {
                available: false,
                platform: if cfg!(target_os = "ios") {
                    "ios".into()
                } else {
                    "android".into()
                },
                reason: Some(format!("availability probe failed: {e}")),
            }))
    }

    pub fn request_permission(&self) -> crate::Result<PermissionResponse> {
        self.0
            .run_mobile_plugin::<PermissionResponse>("requestPermission", ())
            .map_err(Into::into)
    }

    pub fn get_token(&self) -> crate::Result<TokenResponse> {
        self.0
            .run_mobile_plugin::<TokenResponse>("getToken", ())
            .map_err(Into::into)
    }

    pub fn get_launch_tap(&self) -> crate::Result<LaunchTapResponse> {
        self.0
            .run_mobile_plugin::<LaunchTapResponse>("getLaunchTap", ())
            .map_err(Into::into)
    }
}
