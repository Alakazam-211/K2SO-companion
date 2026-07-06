use serde::{Serialize, Serializer};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// Push is not available on this platform/build (desktop, or a
    /// mobile build without provisioning). Callers should have gated
    /// on `is_available()` first; this is the graceful fallback.
    #[error("push notifications unavailable: {0}")]
    Unavailable(String),
    /// The native (Swift/Kotlin) layer rejected the call.
    #[cfg(mobile)]
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
}

impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}
