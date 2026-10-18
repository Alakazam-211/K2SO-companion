// Commands invocable from the webview (`plugin:k2-push|<command>`).
// `register_listener`/`remove_listener` are the base-class listener
// plumbing `addPluginListener` uses for the `tap`/`tokenRefresh` events.
const COMMANDS: &[&str] = &[
    "is_available",
    "request_permission",
    "get_token",
    "get_launch_tap",
    "cache_avatars",
    "set_server_totals",
    "clear_server_totals",
    "get_badge_totals",
    "get_badge_diagnostics",
    "pick_media",
    "pick_documents",
    "register_listener",
    "remove_listener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
