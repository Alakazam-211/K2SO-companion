mod state;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}

#[cfg(target_os = "ios")]
mod ios_keyboard {
    use objc2::runtime::AnyObject;
    use objc2::{msg_send, sel, class};

    /// Disables WKWebView's native scroll view so web content handles all scrolling.
    pub fn setup(webview_ptr: *mut std::ffi::c_void) {
        unsafe {
            let wk: *mut AnyObject = webview_ptr.cast();

            let scroll_view: *mut AnyObject = msg_send![wk, scrollView];
            let _: () = msg_send![scroll_view, setScrollEnabled: false];
            let _: () = msg_send![scroll_view, setContentInsetAdjustmentBehavior: 2i64]; // .never
            let _: () = msg_send![scroll_view, setBounces: false];

            // Inject JS that listens for keyboard height changes via visualViewport
            // This is more reliable than native notifications since we disabled the scroll view
            let js = r#"
                (function() {
                    if (window.__k2KeyboardSetup) return;
                    window.__k2KeyboardSetup = true;

                    var lastHeight = window.innerHeight;

                    function checkHeight() {
                        var vv = window.visualViewport;
                        var h = vv ? vv.height : window.innerHeight;
                        if (h !== lastHeight) {
                            lastHeight = h;
                            window.dispatchEvent(new CustomEvent('k2-viewport-resize', { detail: { height: h } }));
                        }
                    }

                    if (window.visualViewport) {
                        window.visualViewport.addEventListener('resize', checkHeight);
                    }
                    window.addEventListener('resize', checkHeight);

                    // Also poll briefly after focus events since keyboard animation takes time
                    document.addEventListener('focusin', function() {
                        setTimeout(checkHeight, 100);
                        setTimeout(checkHeight, 300);
                        setTimeout(checkHeight, 500);
                    });
                    document.addEventListener('focusout', function() {
                        setTimeout(checkHeight, 100);
                        setTimeout(checkHeight, 300);
                    });
                })();
            "#;

            let ns_string_class = class!(NSString);
            let js_nsstring: *mut AnyObject = msg_send![ns_string_class, alloc];
            let js_nsstring: *mut AnyObject = msg_send![js_nsstring, initWithUTF8String: js.as_ptr()];

            let _: () = msg_send![wk, evaluateJavaScript: js_nsstring completionHandler: std::ptr::null::<AnyObject>()];
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            #[cfg(target_os = "ios")]
            {
                use tauri::Manager;
                if let Some(webview) = app.get_webview_window("main") {
                    let _ = webview.with_webview(|wv| {
                        ios_keyboard::setup(wv.inner());
                    });
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running K2SO Companion");
}
