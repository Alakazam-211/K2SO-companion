use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::K2PushExt;
use crate::Result;

#[command]
pub(crate) async fn is_available<R: Runtime>(app: AppHandle<R>) -> Result<Availability> {
    app.k2_push().is_available()
}

#[command]
pub(crate) async fn request_permission<R: Runtime>(
    app: AppHandle<R>,
) -> Result<PermissionResponse> {
    app.k2_push().request_permission()
}

#[command]
pub(crate) async fn get_token<R: Runtime>(app: AppHandle<R>) -> Result<TokenResponse> {
    app.k2_push().get_token()
}

#[command]
pub(crate) async fn get_launch_tap<R: Runtime>(app: AppHandle<R>) -> Result<LaunchTapResponse> {
    app.k2_push().get_launch_tap()
}
