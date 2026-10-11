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

    /// UIUserInterfaceStyleDark. The app is all dark, so the keyboard should be too.
    const UI_USER_INTERFACE_STYLE_DARK: i64 = 2;

    /// Forces dark appearance on the WKWebView, its window, and every window of
    /// every connected scene. Keyboards for web inputs follow the trait
    /// collection, so this keeps them dark when the system is in Light mode.
    /// Belt-and-braces with `UIUserInterfaceStyle = Dark` in Info.ios.plist.
    /// Idempotent; must run on the main thread.
    pub fn force_dark(webview_ptr: *mut std::ffi::c_void) {
        unsafe {
            let wk: *mut AnyObject = webview_ptr.cast();
            if !wk.is_null() {
                let _: () = msg_send![wk, setOverrideUserInterfaceStyle: UI_USER_INTERFACE_STYLE_DARK];
                let window: *mut AnyObject = msg_send![wk, window];
                if !window.is_null() {
                    let _: () = msg_send![window, setOverrideUserInterfaceStyle: UI_USER_INTERFACE_STYLE_DARK];
                }
            }
            // UIScene app: walk connectedScenes -> windows.
            let app: *mut AnyObject = msg_send![class!(UIApplication), sharedApplication];
            if app.is_null() {
                return;
            }
            let scenes: *mut AnyObject = msg_send![app, connectedScenes];
            if scenes.is_null() {
                return;
            }
            let scenes: *mut AnyObject = msg_send![scenes, allObjects];
            if scenes.is_null() {
                return;
            }
            let window_scene = class!(UIWindowScene);
            let n: usize = msg_send![scenes, count];
            for i in 0..n {
                let scene: *mut AnyObject = msg_send![scenes, objectAtIndex: i];
                if scene.is_null() {
                    continue;
                }
                let is_window_scene: bool = msg_send![scene, isKindOfClass: window_scene];
                if !is_window_scene {
                    continue;
                }
                let windows: *mut AnyObject = msg_send![scene, windows];
                if windows.is_null() {
                    continue;
                }
                let wn: usize = msg_send![windows, count];
                for j in 0..wn {
                    let w: *mut AnyObject = msg_send![windows, objectAtIndex: j];
                    if !w.is_null() {
                        let _: () = msg_send![w, setOverrideUserInterfaceStyle: UI_USER_INTERFACE_STYLE_DARK];
                    }
                }
            }
        }
    }

    // ── Resume / keyboard re-sync (IMG_0844) ─────────────────────────
    //
    // Coming back from the background with the composer focused, iOS
    // re-shows the keyboard and WebKit pans the web content up to reveal
    // the input: the scroll view's contentOffset moves even with
    // scrolling disabled, and no focusin fires (focus never left), so the
    // fixed column slid under the status bar. UIKit notifications tell
    // the page to re-measure (`window.__k2ViewportPing`, injected below);
    // when no keyboard can be up (hidden / app just became active) the
    // pan is reset here too. With the keyboard up the web hook
    // (useViewportHeight) decides, since a screen without it may rely on
    // WebKit's reveal scroll.

    use std::sync::atomic::{AtomicPtr, Ordering};

    static WEBVIEW: AtomicPtr<std::ffi::c_void> = AtomicPtr::new(std::ptr::null_mut());
    const OBSERVER_CLASS_NAME: &std::ffi::CStr = c"K2ViewportObserver";

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGPoint {
        x: f64,
        y: f64,
    }

    unsafe impl objc2::Encode for CGPoint {
        const ENCODING: objc2::Encoding =
            objc2::Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }

    #[link(name = "UIKit", kind = "framework")]
    extern "C" {
        static UIKeyboardDidShowNotification: *const AnyObject;
        static UIKeyboardDidHideNotification: *const AnyObject;
        static UIApplicationDidBecomeActiveNotification: *const AnyObject;
    }

    /// Scroll the WKWebView's (disabled) scroll view back to the origin.
    fn reset_content_offset(wk: *mut AnyObject) {
        unsafe {
            let scroll_view: *mut AnyObject = msg_send![wk, scrollView];
            if scroll_view.is_null() {
                return;
            }
            // Keep insets from being re-derived from the keyboard/safe area.
            let _: () = msg_send![scroll_view, setContentInsetAdjustmentBehavior: 2i64]; // .never
            let current: CGPoint = msg_send![scroll_view, contentOffset];
            if current.x != 0.0 || current.y != 0.0 {
                let zero = CGPoint { x: 0.0, y: 0.0 };
                let _: () = msg_send![scroll_view, setContentOffset: zero, animated: false];
            }
        }
    }

    /// Ask the page to re-measure (k2-viewport-resize + k2-viewport-resync).
    fn ping_page(wk: *mut AnyObject) {
        unsafe {
            let js = c"window.__k2ViewportPing && window.__k2ViewportPing();";
            let s: *mut AnyObject = msg_send![class!(NSString), stringWithUTF8String: js.as_ptr()];
            if s.is_null() {
                return;
            }
            let _: () = msg_send![wk, evaluateJavaScript: s, completionHandler: std::ptr::null::<AnyObject>()];
        }
    }

    fn live_webview() -> Option<*mut AnyObject> {
        let wk = WEBVIEW.load(Ordering::Acquire);
        if wk.is_null() {
            None
        } else {
            Some(wk.cast())
        }
    }

    extern "C-unwind" fn on_keyboard_did_show(_this: &AnyObject, _cmd: Sel, _note: *mut AnyObject) {
        if let Some(wk) = live_webview() {
            ping_page(wk);
        }
    }

    extern "C-unwind" fn on_reset(_this: &AnyObject, _cmd: Sel, _note: *mut AnyObject) {
        if let Some(wk) = live_webview() {
            reset_content_offset(wk);
            ping_page(wk);
        }
    }

    /// Registers the keyboard / app-active observers once per process.
    fn install_observers(webview_ptr: *mut std::ffi::c_void) {
        WEBVIEW.store(webview_ptr, Ordering::Release);
        if AnyClass::get(OBSERVER_CLASS_NAME).is_some() {
            return; // already observing; the pointer above is refreshed
        }
        let Some(mut builder) = ClassBuilder::new(OBSERVER_CLASS_NAME, class!(NSObject)) else {
            return;
        };
        unsafe {
            builder.add_method(
                sel!(k2KeyboardDidShow:),
                on_keyboard_did_show as extern "C-unwind" fn(_, _, _),
            );
            builder.add_method(sel!(k2ResetViewport:), on_reset as extern "C-unwind" fn(_, _, _));
        }
        let cls = builder.register();
        unsafe {
            // Lives for the process (never released): the center keeps a
            // weak reference.
            let observer: *mut AnyObject = msg_send![cls, new];
            if observer.is_null() {
                return;
            }
            let center: *mut AnyObject = msg_send![class!(NSNotificationCenter), defaultCenter];
            if center.is_null() {
                return;
            }
            let none = std::ptr::null::<AnyObject>();
            let _: () = msg_send![center, addObserver: observer, selector: sel!(k2KeyboardDidShow:), name: UIKeyboardDidShowNotification, object: none];
            let _: () = msg_send![center, addObserver: observer, selector: sel!(k2ResetViewport:), name: UIKeyboardDidHideNotification, object: none];
            let _: () = msg_send![center, addObserver: observer, selector: sel!(k2ResetViewport:), name: UIApplicationDidBecomeActiveNotification, object: none];
        }
    }

    /// Disables WKWebView's native scroll view so web content handles all scrolling.
    pub fn setup(webview_ptr: *mut std::ffi::c_void) {
        unsafe {
            let wk: *mut AnyObject = webview_ptr.cast();

            // Dark keyboard / controls regardless of system appearance.
            force_dark(webview_ptr);

            let scroll_view: *mut AnyObject = msg_send![wk, scrollView];
            let _: () = msg_send![scroll_view, setScrollEnabled: false];
            let _: () = msg_send![scroll_view, setContentInsetAdjustmentBehavior: 2i64]; // .never
            let _: () = msg_send![scroll_view, setBounces: false];

            // Kill the keyboard accessory bar for all web inputs.
            strip_accessory_bar(webview_ptr);

            // Re-pin the page on keyboard show/hide and app resume.
            install_observers(webview_ptr);

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

                    // Native ping (keyboard did show/hide, app did become
                    // active): always re-send the height, then ask the page
                    // to re-measure + reset any pan (useViewportHeight).
                    window.__k2ViewportPing = function() {
                        var vv = window.visualViewport;
                        lastHeight = vv ? vv.height : window.innerHeight;
                        window.dispatchEvent(new CustomEvent('k2-viewport-resize', { detail: { height: lastHeight } }));
                        window.dispatchEvent(new Event('k2-viewport-resync'));
                    };

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
fn open_external_url(url: String, webview: tauri::WebviewWindow) -> Result<(), String> {
    let trimmed = url.trim().to_string();
    let lower = trimmed.to_ascii_lowercase();
    if !(lower.starts_with("https://")
        || lower.starts_with("http://")
        || lower.starts_with("mailto:")
        || lower.starts_with("tel:"))
    {
        return Err("unsupported url".into());
    }
    #[cfg(target_os = "ios")]
    {
        let to_open = trimmed.clone();
        let slot = std::sync::Arc::new(std::sync::Mutex::new(Ok(())));
        let out = slot.clone();
        webview
            .with_webview(move |_wv| {
                *out.lock().expect("opener slot") = ios_open::open_url(&to_open);
            })
            .map_err(|e| e.to_string())?;
        return slot
            .lock()
            .map_err(|e| e.to_string())?
            .clone();
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = webview;
        let _ = trimmed;
        Err("no native opener".into())
    }
}

#[cfg(target_os = "ios")]
mod ios_open {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use std::ffi::CString;

    pub fn open_url(url: &str) -> Result<(), String> {
        let c = CString::new(url).map_err(|_| "url")?;
        unsafe {
            let nsstr: *mut AnyObject =
                msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()];
            if nsstr.is_null() {
                return Err("nsstring".into());
            }
            let nsurl: *mut AnyObject = msg_send![class!(NSURL), URLWithString: nsstr];
            if nsurl.is_null() {
                return Err("nsurl".into());
            }
            let app: *mut AnyObject = msg_send![class!(UIApplication), sharedApplication];
            if app.is_null() {
                return Err("app".into());
            }
            // iOS 26 forces UIApplication.openURL(_:) to return false.
            // Use openURL:options:completionHandler: (completion may be nil).
            let opts: *mut AnyObject = msg_send![class!(NSDictionary), dictionary];
            let handler: *mut AnyObject = std::ptr::null_mut();
            let _: () = msg_send![
                app,
                openURL: nsurl,
                options: opts,
                completionHandler: handler
            ];
            Ok(())
        }
    }
}

#[tauri::command]
fn ios_strip_accessory_bar(webview: tauri::WebviewWindow) {
    #[cfg(target_os = "ios")]
    {
        let _ = webview.with_webview(|wv| {
            ios_keyboard::strip_accessory_bar(wv.inner());
            // Re-assert dark style: a window/scene created after startup
            // (e.g. iPad second scene) gets it on first input focus.
            ios_keyboard::force_dark(wv.inner());
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
        .invoke_handler(tauri::generate_handler![
            greet,
            ios_strip_accessory_bar,
            open_external_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running K2 Companion");
}
