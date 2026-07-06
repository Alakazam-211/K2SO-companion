mod state;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}

#[cfg(target_os = "ios")]
mod ios_keyboard {
    use objc2::runtime::{AnyClass, AnyObject, ClassBuilder, Sel};
    use objc2::{msg_send, sel, class};

    const NO_ACCESSORY_CLASS_NAME: &std::ffi::CStr = c"K2NoAccessoryContentView";

    extern "C-unwind" fn null_input_accessory_view(
        _this: &AnyObject,
        _cmd: Sel,
    ) -> *mut AnyObject {
        std::ptr::null_mut()
    }

    /// Removes the system keyboard accessory bar (form prev/next arrows + Done)
    /// by swapping the WKContentView's class for a lazily-registered runtime
    /// subclass whose `inputAccessoryView` returns nil.
    ///
    /// Idempotent: once reclassed, the view's class name no longer starts with
    /// "WKContent", so subsequent walks are no-ops. Must run on the main thread.
    /// Failure-silent: if the content view isn't found, nothing happens.
    pub fn strip_accessory_bar(webview_ptr: *mut std::ffi::c_void) {
        unsafe {
            let wk: *mut AnyObject = webview_ptr.cast();
            if wk.is_null() {
                return;
            }
            let scroll_view: *mut AnyObject = msg_send![wk, scrollView];
            if scroll_view.is_null() {
                return;
            }
            let subviews: *mut AnyObject = msg_send![scroll_view, subviews];
            if subviews.is_null() {
                return;
            }
            let count: usize = msg_send![subviews, count];
            for i in 0..count {
                let sv: *mut AnyObject = msg_send![subviews, objectAtIndex: i];
                if sv.is_null() {
                    continue;
                }
                let cls = (*sv).class();
                if !cls.name().to_bytes().starts_with(b"WKContent") {
                    continue;
                }
                // Lazily register the subclass; registration happens once per process.
                let subclass = match AnyClass::get(NO_ACCESSORY_CLASS_NAME) {
                    Some(existing) => existing,
                    None => match ClassBuilder::new(NO_ACCESSORY_CLASS_NAME, cls) {
                        Some(mut builder) => {
                            builder.add_method(
                                sel!(inputAccessoryView),
                                null_input_accessory_view
                                    as extern "C-unwind" fn(_, _) -> _,
                            );
                            builder.register()
                        }
                        None => continue,
                    },
                };
                // Only reclass if the subclass actually extends this view's class
                // (guards against a WebKit class change across content-process respawns).
                if subclass.superclass() != Some(cls) {
                    continue;
                }
                AnyObject::set_class(&*sv, subclass);
            }
        }
    }

    /// Disables WKWebView's native scroll view so web content handles all scrolling.
    pub fn setup(webview_ptr: *mut std::ffi::c_void) {
        unsafe {
            let wk: *mut AnyObject = webview_ptr.cast();

            let scroll_view: *mut AnyObject = msg_send![wk, scrollView];
            let _: () = msg_send![scroll_view, setScrollEnabled: false];
            let _: () = msg_send![scroll_view, setContentInsetAdjustmentBehavior: 2i64]; // .never
            let _: () = msg_send![scroll_view, setBounces: false];

            // Kill the keyboard accessory bar for all web inputs.
            strip_accessory_bar(webview_ptr);

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
                        // Re-strip the keyboard accessory bar: WebKit recreates the
                        // WKContentView after a content-process respawn, dropping our
                        // runtime subclass. Cheap no-op when already stripped.
                        try {
                            if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
                                window.__TAURI_INTERNALS__.invoke('ios_strip_accessory_bar').catch(function() {});
                            }
                        } catch (e) {}
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

/// Re-applies the accessory-bar strip against the live WKWebView.
///
/// Tauri commands don't run on the main thread, but `with_webview` dispatches
/// its closure through the runtime's event loop, which IS the main thread on
/// iOS — so no raw-pointer stash is needed; we re-fetch the platform webview
/// each call. No-op on non-iOS targets (and the calling JS is only injected
/// on iOS anyway).
#[tauri::command]
fn ios_strip_accessory_bar(webview: tauri::WebviewWindow) {
    #[cfg(target_os = "ios")]
    {
        let _ = webview.with_webview(|wv| {
            ios_keyboard::strip_accessory_bar(wv.inner());
        });
    }
    #[cfg(not(target_os = "ios"))]
    let _ = webview;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_k2_push::init())
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
        .invoke_handler(tauri::generate_handler![greet, ios_strip_accessory_bar])
        .run(tauri::generate_context!())
        .expect("error while running K2 Companion");
}
