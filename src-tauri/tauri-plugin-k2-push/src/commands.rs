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
    key: Option<String>,
    subdomain: Option<String>,
    unread: u32,
    waiting: Option<u32>,
) -> Result<BadgeSumResponse> {
    app.k2_push().set_server_totals(ServerTotalsRequest {
        key,
        subdomain,
        unread,
        waiting,
    })
}

#[command]
pub(crate) async fn clear_server_totals<R: Runtime>(
    app: AppHandle<R>,
    key: Option<String>,
    subdomain: Option<String>,
) -> Result<BadgeSumResponse> {
    app.k2_push()
        .clear_server_totals(ClearServerTotalsRequest { key, subdomain })
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

#[command]
pub(crate) async fn pick_media<R: Runtime>(
    app: AppHandle<R>,
    limit: Option<u32>,
    max_bytes: Option<u64>,
    max_total_bytes: Option<u64>,
) -> Result<PickResponse> {
    app.k2_push()
        .pick_media(PickRequest {
            limit,
            max_bytes,
            max_total_bytes,
        })
        .await
}

#[command]
pub(crate) async fn pick_documents<R: Runtime>(
    app: AppHandle<R>,
    max_bytes: Option<u64>,
    max_total_bytes: Option<u64>,
) -> Result<PickResponse> {
    app.k2_push()
        .pick_documents(PickRequest {
            limit: None,
            max_bytes,
            max_total_bytes,
        })
        .await
}

#[command]
pub(crate) async fn scan_qr<R: Runtime>(app: AppHandle<R>) -> Result<ScanQrResponse> {
    app.k2_push().scan_qr().await
}

#[command]
pub(crate) async fn e2e_op<R: Runtime>(
    app: AppHandle<R>,
    op: String,
    server: Option<String>,
    subdomain: Option<String>,
    rotate: Option<bool>,
    on: Option<bool>,
) -> Result<serde_json::Value> {
    app.k2_push().e2e_op(E2eOpRequest {
        op,
        server,
        subdomain,
        rotate,
        on,
    })
}
