use serde::{Deserialize, Serialize};
use std::sync::Mutex;

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
pub struct Credentials {
    pub server_url: String,
    pub username: String,
    pub password: String,
    pub session_token: Option<String>,
}

#[derive(Debug, Default)]
pub struct AppState {
    pub credentials: Mutex<Option<Credentials>>,
}

impl AppState {
    pub fn new() -> Self {
        Self::default()
    }
}
