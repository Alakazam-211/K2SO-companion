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

#[command]
pub(crate) async fn cache_avatars<R: Runtime>(
    app: AppHandle<R>,
    items: Vec<AvatarItem>,
) -> Result<CacheAvatarsResponse> {
    app.k2_push().cache_avatars(CacheAvatarsRequest { items })
}

#[command]
pub(crate) async fn set_server_totals<R: Runtime>(
    app: AppHandle<R>,
    subdomain: String,
    unread: u32,
    waiting: Option<u32>,
) -> Result<BadgeSumResponse> {
    app.k2_push().set_server_totals(ServerTotalsRequest {
        subdomain,
        unread,
        waiting,
    })
}

#[command]
pub(crate) async fn clear_server_totals<R: Runtime>(
    app: AppHandle<R>,
    subdomain: String,
) -> Result<BadgeSumResponse> {
    app.k2_push()
        .clear_server_totals(ClearServerTotalsRequest { subdomain })
}

#[command]
pub(crate) async fn get_badge_totals<R: Runtime>(app: AppHandle<R>) -> Result<BadgeTotalsResponse> {
    app.k2_push().get_badge_totals()
}

#[command]
pub(crate) async fn get_badge_diagnostics<R: Runtime>(
    app: AppHandle<R>,
) -> Result<BadgeDiagnosticsResponse> {
    app.k2_push().get_badge_diagnostics()
}
