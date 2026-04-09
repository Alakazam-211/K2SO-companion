use crate::state::{AppState, Credentials};
use tauri::State;
use tauri_plugin_store::StoreExt;

const STORE_PATH: &str = "credentials.json";
const STORE_KEY: &str = "credentials";

#[tauri::command]
pub fn save_credentials(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    server_url: String,
    username: String,
    password: String,
) -> Result<(), String> {
    let creds = Credentials {
        server_url,
        username,
        password,
        session_token: None,
    };

    // Save to in-memory state
    {
        let mut lock = state.credentials.lock().map_err(|e| e.to_string())?;
        *lock = Some(creds.clone());
    }

    // Persist to store
    let store = app.store(STORE_PATH).map_err(|e| e.to_string())?;
    store
        .set(STORE_KEY, serde_json::to_value(&creds).map_err(|e| e.to_string())?);
    store.save().map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn load_credentials(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<Credentials>, String> {
    // Check in-memory first
    {
        let lock = state.credentials.lock().map_err(|e| e.to_string())?;
        if lock.is_some() {
            return Ok(lock.clone());
        }
    }

    // Try loading from persistent store
    let store = app.store(STORE_PATH).map_err(|e| e.to_string())?;
    if let Some(value) = store.get(STORE_KEY) {
        let creds: Credentials =
            serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
        let mut lock = state.credentials.lock().map_err(|e| e.to_string())?;
        *lock = Some(creds.clone());
        return Ok(Some(creds));
    }

    Ok(None)
}

#[tauri::command]
pub fn clear_credentials(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Clear in-memory
    {
        let mut lock = state.credentials.lock().map_err(|e| e.to_string())?;
        *lock = None;
    }

    // Clear persistent store
    let store = app.store(STORE_PATH).map_err(|e| e.to_string())?;
    store.delete(STORE_KEY);
    store.save().map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn set_session_token(
    state: State<'_, AppState>,
    token: String,
) -> Result<(), String> {
    let mut lock = state.credentials.lock().map_err(|e| e.to_string())?;
    if let Some(ref mut creds) = *lock {
        creds.session_token = Some(token);
    }
    Ok(())
}
