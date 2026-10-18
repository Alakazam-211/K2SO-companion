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

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGSize {
        width: f64,
        height: f64,
    }

    unsafe impl objc2::Encode for CGSize {
        const ENCODING: objc2::Encoding =
            objc2::Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGRect {
        origin: CGPoint,
        size: CGSize,
    }

    unsafe impl objc2::Encode for CGRect {
        const ENCODING: objc2::Encoding =
            objc2::Encoding::Struct("CGRect", &[CGPoint::ENCODING, CGSize::ENCODING]);
    }

    #[link(name = "UIKit", kind = "framework")]
    extern "C" {
        static UIKeyboardDidShowNotification: *const AnyObject;
        static UIKeyboardDidHideNotification: *const AnyObject;
        static UIKeyboardWillShowNotification: *const AnyObject;
        static UIKeyboardWillHideNotification: *const AnyObject;
        static UIKeyboardWillChangeFrameNotification: *const AnyObject;
        static UIKeyboardAnimationDurationUserInfoKey: *const AnyObject;
        static UIKeyboardAnimationCurveUserInfoKey: *const AnyObject;
        static UIKeyboardFrameEndUserInfoKey: *const AnyObject;
        static UIApplicationDidBecomeActiveNotification: *const AnyObject;
    }

    #[link(name = "Foundation", kind = "framework")]
    extern "C" {
        static NSRunLoopCommonModes: *const AnyObject;
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

    /// Run a JS snippet in the page (fire and forget).
    fn eval_js(wk: *mut AnyObject, js: &str) {
        let Ok(c) = std::ffi::CString::new(js) else {
            return;
        };
        unsafe {
            let s: *mut AnyObject = msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()];
            if s.is_null() {
                return;
            }
            let _: () = msg_send![wk, evaluateJavaScript: s, completionHandler: std::ptr::null::<AnyObject>()];
        }
    }

    // ── Keyboard motion ──────────────────────────────────────────────
    //
    // UIKeyboardWill{Show,Hide,ChangeFrame} arrive as the keyboard starts
    // to move, with its end frame, duration and curve. The page
    // (useViewportHeight) goes straight to the height the keyboard is
    // heading for and eases its column on the same curve, so the composer
    // rides the keyboard instead of stepping after it.

    /// How far a keyboard ending at `end` (screen coordinates) covers the
    /// web view's bottom edge, in the web view's points (= CSS px).
    fn keyboard_overlap(wk: *mut AnyObject, end: CGRect) -> f64 {
        unsafe {
            let window: *mut AnyObject = msg_send![wk, window];
            if window.is_null() {
                return 0.0;
            }
            let screen: *mut AnyObject = msg_send![window, screen];
            if screen.is_null() {
                return 0.0;
            }
            let space: *mut AnyObject = msg_send![screen, coordinateSpace];
            if space.is_null() {
                return 0.0;
            }
            let r: CGRect = msg_send![wk, convertRect: end, fromCoordinateSpace: space];
            let b: CGRect = msg_send![wk, bounds];
            let bottom = b.origin.y + b.size.height;
            // Floating / undocked keyboards do not reach the bottom edge.
            if r.size.height <= 0.0 || r.origin.y + r.size.height < bottom - 1.0 {
                return 0.0;
            }
            (bottom - r.origin.y).clamp(0.0, b.size.height.max(0.0))
        }
    }

    /// Tell the page where the keyboard is heading and how it gets there
    /// (`window.__k2KeyboardWill`).
    fn keyboard_will(note: *mut AnyObject, hiding: bool) {
        let Some(wk) = live_webview() else {
            return;
        };
        let mut duration_ms = 250.0f64;
        let mut curve: isize = 7;
        let mut overlap = 0.0f64;
        unsafe {
            let info: *mut AnyObject = if note.is_null() {
                std::ptr::null_mut()
            } else {
                msg_send![note, userInfo]
            };
            if !info.is_null() {
                let d: *mut AnyObject =
                    msg_send![info, objectForKey: UIKeyboardAnimationDurationUserInfoKey];
                if !d.is_null() {
                    let secs: f64 = msg_send![d, doubleValue];
                    if secs.is_finite() && secs >= 0.0 {
                        duration_ms = secs * 1000.0;
                    }
                }
                let c: *mut AnyObject =
                    msg_send![info, objectForKey: UIKeyboardAnimationCurveUserInfoKey];
                if !c.is_null() {
                    curve = msg_send![c, integerValue];
                }
                if !hiding {
                    let f: *mut AnyObject =
                        msg_send![info, objectForKey: UIKeyboardFrameEndUserInfoKey];
                    if !f.is_null() {
                        let end: CGRect = msg_send![f, CGRectValue];
                        overlap = keyboard_overlap(wk, end);
                    }
                }
            }
        }
        let at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let show = !hiding && overlap > 0.0;
        // The keyboard moves on its own now: the frame tracker stands down
        // until it lands (then re-bases on wherever that is).
        TRACK.with(|t| {
            t.borrow_mut().anim_until =
                Some(Instant::now() + Duration::from_millis(duration_ms as u64 + 40));
        });
        if show {
            set_interactive_dismiss(wk);
            start_tracking();
        }
        let js = format!(
            "window.__k2KeyboardWill && window.__k2KeyboardWill({{height:{:.1},duration:{:.0},curve:{},show:{},at:{}}});",
            overlap, duration_ms, curve, show, at
        );
        eval_js(wk, &js);
    }

    extern "C-unwind" fn on_keyboard_will_change(_this: &AnyObject, _cmd: Sel, note: *mut AnyObject) {
        keyboard_will(note, false);
    }

    extern "C-unwind" fn on_keyboard_will_hide(_this: &AnyObject, _cmd: Sel, note: *mut AnyObject) {
        keyboard_will(note, true);
    }

    // ── Interactive dismiss (iMessage) ───────────────────────────────
    //
    // The Thread's list is an overflow:auto div, which WebKit backs with a
    // native child UIScrollView (WKChildScrollView). With
    // keyboardDismissMode = .interactive, dragging it down into the
    // keyboard moves the keyboard with the finger. UIKit posts no
    // notifications while the finger drags it. The page does not move
    // the composer per frame (IPC jitter): it switches a stand-in of it
    // into the natively scrolled list content as the drag starts
    // (src/zen/keyboardDragDock.ts), normally on a touchmove crossing the
    // keyboard's top minus keyboardDismissPadding (iOS 17+, the composer's
    // height, set from the page: ios_keyboard_dismiss_padding). As a
    // fallback trigger, while the keyboard is up a CADisplayLink reads its
    // top every frame and posts ONE `window.__k2KeyboardTrack(overlap)`
    // when it leaves its rest with no Will* animation in flight (re-armed
    // back at rest). On release UIKit posts WillHide / WillShow with the
    // rest of the animation, which takes over (keyboard_will).
    //
    // Keyboard top: UIKeyboardLayoutGuide (public, iOS 15+) first. If it
    // sits still while the keyboard's host view moves (it did not follow
    // the interactive drag), the host view's frame is used: found by
    // class name in the scene's windows, only its public geometry read.
    // Absent views / selectors just mean no tracking.

    const UI_SCROLL_VIEW_KEYBOARD_DISMISS_MODE_INTERACTIVE: isize = 2;
    /// Re-apply the dismiss mode every this many frames (WebKit creates
    /// child scroll views lazily, and recreates them on re-layering).
    const REAPPLY_TICKS: u32 = 45;

    use std::cell::RefCell;
    use std::sync::atomic::AtomicU64;

    /// keyboardDismissPadding (iOS 17+) for every scroll view: the
    /// composer's height, so a dismiss drag starts at its top (f64 bits).
    static DISMISS_PADDING: AtomicU64 = AtomicU64::new(0);

    /// Whether this iOS has `UIScrollView.keyboardDismissPadding`.
    pub fn dismiss_padding_supported() -> bool {
        let Some(cls) = AnyClass::get(c"UIScrollView") else {
            return false;
        };
        unsafe { msg_send![cls, instancesRespondToSelector: sel!(setKeyboardDismissPadding:)] }
    }

    /// Store the padding and apply it to the live web view's scroll views.
    pub fn set_dismiss_padding(webview_ptr: *mut std::ffi::c_void, px: f64) {
        let px = if px.is_finite() { px.clamp(0.0, 400.0) } else { 0.0 };
        DISMISS_PADDING.store(px.to_bits(), Ordering::Release);
        let wk: *mut AnyObject = webview_ptr.cast();
        if !wk.is_null() {
            set_interactive_dismiss(wk);
        }
    }
    use std::time::{Duration, Instant};

    static OBSERVER: AtomicPtr<AnyObject> = AtomicPtr::new(std::ptr::null_mut());
    static LINK: AtomicPtr<AnyObject> = AtomicPtr::new(std::ptr::null_mut());

    #[derive(Clone, Copy, PartialEq)]
    enum TrackSource {
        Guide,
        Host,
    }

    struct Track {
        /// A Will* animation owns the keyboard until then.
        anim_until: Option<Instant>,
        /// Next tick takes the current values as the baseline, sends nothing.
        rebase: bool,
        prev_guide: f64,
        prev_host: f64,
        /// The keyboard's resting overlap (baseline at the last rebase).
        sent: f64,
        source: TrackSource,
        ticks: u32,
        guide_configured: bool,
        /// "Started moving" already posted for this excursion from rest.
        signaled: bool,
    }

    thread_local! {
        // Main thread only (notifications + display link).
        static TRACK: RefCell<Track> = RefCell::new(Track {
            anim_until: None,
            rebase: true,
            prev_guide: 0.0,
            prev_host: 0.0,
            sent: 0.0,
            source: TrackSource::Guide,
            ticks: 0,
            guide_configured: false,
            signaled: false,
        });
    }

    /// `keyboardDismissMode = .interactive` on every UIScrollView inside
    /// the web view except its own (disabled) top-level scroll view.
    fn set_interactive_dismiss(wk: *mut AnyObject) {
        unsafe {
            let Some(scroll_class) = AnyClass::get(c"UIScrollView") else {
                return;
            };
            let top: *mut AnyObject = msg_send![wk, scrollView];
            let mut budget = 5000usize;
            walk_scroll_views(wk, top, scroll_class, 0, &mut budget);
        }
    }

    unsafe fn walk_scroll_views(
        view: *mut AnyObject,
        top: *mut AnyObject,
        scroll_class: &AnyClass,
        depth: u32,
        budget: &mut usize,
    ) {
        if view.is_null() || depth > 64 || *budget == 0 {
            return;
        }
        *budget -= 1;
        if view != top {
            let is_scroll: bool = msg_send![view, isKindOfClass: scroll_class];
            if is_scroll {
                let mode: isize = msg_send![view, keyboardDismissMode];
                if mode != UI_SCROLL_VIEW_KEYBOARD_DISMISS_MODE_INTERACTIVE {
                    let _: () = msg_send![view, setKeyboardDismissMode: UI_SCROLL_VIEW_KEYBOARD_DISMISS_MODE_INTERACTIVE];
                }
                let pad = f64::from_bits(DISMISS_PADDING.load(Ordering::Acquire));
                if pad > 0.0 {
                    let can: bool =
                        msg_send![view, respondsToSelector: sel!(setKeyboardDismissPadding:)];
                    if can {
                        let cur: f64 = msg_send![view, keyboardDismissPadding];
                        if (cur - pad).abs() >= 0.5 {
                            let _: () = msg_send![view, setKeyboardDismissPadding: pad];
                        }
                    }
                }
            }
        }
        let subviews: *mut AnyObject = msg_send![view, subviews];
        if subviews.is_null() {
            return;
        }
        let n: usize = msg_send![subviews, count];
        for i in 0..n {
            let sv: *mut AnyObject = msg_send![subviews, objectAtIndex: i];
            walk_scroll_views(sv, top, scroll_class, depth + 1, budget);
        }
    }

    /// Keyboard overlap of the web view per its keyboardLayoutGuide.
    fn guide_overlap(wk: *mut AnyObject, configure: bool) -> Option<f64> {
        unsafe {
            let has: bool = msg_send![wk, respondsToSelector: sel!(keyboardLayoutGuide)];
            if !has {
                return None;
            }
            let guide: *mut AnyObject = msg_send![wk, keyboardLayoutGuide];
            if guide.is_null() {
                return None;
            }
            if configure {
                // Docked keyboard only; and reach the real bottom edge, not
                // the home-indicator inset, when it is down (iOS 17+).
                let can: bool = msg_send![guide, respondsToSelector: sel!(setFollowsUndockedKeyboard:)];
                if can {
                    let _: () = msg_send![guide, setFollowsUndockedKeyboard: false];
                }
                let can: bool = msg_send![guide, respondsToSelector: sel!(setUsesBottomSafeArea:)];
                if can {
                    let _: () = msg_send![guide, setUsesBottomSafeArea: false];
                }
            }
            let f: CGRect = msg_send![guide, layoutFrame];
            if f.origin.y <= 0.0 && f.size.height <= 0.0 {
                return None; // not laid out yet
            }
            let b: CGRect = msg_send![wk, bounds];
            let bottom = b.origin.y + b.size.height;
            Some((bottom - f.origin.y).clamp(0.0, b.size.height.max(0.0)))
        }
    }

    unsafe fn find_view_named(
        view: *mut AnyObject,
        name: &[u8],
        depth: u32,
    ) -> Option<*mut AnyObject> {
        if view.is_null() || depth > 5 {
            return None;
        }
        if (*view).class().name().to_bytes() == name {
            let b: CGRect = msg_send![view, bounds];
            if b.size.height > 0.0 {
                return Some(view);
            }
        }
        let subviews: *mut AnyObject = msg_send![view, subviews];
        if subviews.is_null() {
            return None;
        }
        let n: usize = msg_send![subviews, count];
        for i in 0..n {
            let sv: *mut AnyObject = msg_send![subviews, objectAtIndex: i];
            if let Some(found) = find_view_named(sv, name, depth + 1) {
                return Some(found);
            }
        }
        None
    }

    /// Keyboard overlap of the web view per the keyboard's host view.
    fn host_overlap(wk: *mut AnyObject) -> Option<f64> {
        unsafe {
            let window: *mut AnyObject = msg_send![wk, window];
            if window.is_null() {
                return None;
            }
            let scene: *mut AnyObject = msg_send![window, windowScene];
            if scene.is_null() {
                return None;
            }
            let windows: *mut AnyObject = msg_send![scene, windows];
            if windows.is_null() {
                return None;
            }
            let n: usize = msg_send![windows, count];
            for i in 0..n {
                let w: *mut AnyObject = msg_send![windows, objectAtIndex: i];
                if w.is_null() || w == window {
                    continue;
                }
                let Some(host) = find_view_named(w, b"UIInputSetHostView", 0) else {
                    continue;
                };
                let hb: CGRect = msg_send![host, bounds];
                let in_window: CGRect =
                    msg_send![host, convertRect: hb, toView: std::ptr::null_mut::<AnyObject>()];
                let screen: *mut AnyObject = msg_send![w, screen];
                if screen.is_null() {
                    continue;
                }
                let space: *mut AnyObject = msg_send![screen, coordinateSpace];
                if space.is_null() {
                    continue;
                }
                let on_screen: CGRect =
                    msg_send![w, convertRect: in_window, toCoordinateSpace: space];
                return Some(keyboard_overlap(wk, on_screen));
            }
            None
        }
    }

    fn send_track(wk: *mut AnyObject, overlap: f64) {
        let js = format!(
            "window.__k2KeyboardTrack && window.__k2KeyboardTrack({:.1});",
            overlap
        );
        eval_js(wk, &js);
    }

    extern "C-unwind" fn on_keyboard_tick(_this: &AnyObject, _cmd: Sel, _link: *mut AnyObject) {
        let Some(wk) = live_webview() else {
            return;
        };
        let now = Instant::now();
        let (reapply, configure) = TRACK.with(|t| {
            let mut t = t.borrow_mut();
            t.ticks = t.ticks.wrapping_add(1);
            let configure = !t.guide_configured;
            t.guide_configured = true;
            (t.ticks % REAPPLY_TICKS == 0, configure)
        });
        if reapply {
            set_interactive_dismiss(wk);
        }
        let guide = guide_overlap(wk, configure);
        let host = host_overlap(wk);
        let send = TRACK.with(|t| {
            let mut t = t.borrow_mut();
            let animating = t.anim_until.map_or(false, |until| now < until);
            if animating || t.rebase {
                if !animating {
                    t.anim_until = None;
                    t.rebase = false;
                } else {
                    t.rebase = true;
                }
                if let Some(g) = guide {
                    t.prev_guide = g;
                }
                if let Some(h) = host {
                    t.prev_host = h;
                }
                t.sent = guide.or(host).unwrap_or(t.sent);
                t.source = TrackSource::Guide;
                t.signaled = false;
                return None;
            }
            let guide_moved = guide.map_or(false, |g| (g - t.prev_guide).abs() >= 0.5);
            let host_moved = host.map_or(false, |h| (h - t.prev_host).abs() >= 0.5);
            if let Some(g) = guide {
                t.prev_guide = g;
            }
            if let Some(h) = host {
                t.prev_host = h;
            }
            if guide_moved {
                t.source = TrackSource::Guide;
            } else if host_moved {
                t.source = TrackSource::Host;
            }
            let cur = match t.source {
                TrackSource::Guide => guide.or(host),
                TrackSource::Host => host.or(guide),
            }?;
            // Only the start of an excursion is posted: the page moves the
            // composer into the natively scrolled content then, and
            // scrolling carries it (no per-frame IPC). Back at rest re-arms.
            if (cur - t.sent).abs() < 0.5 {
                t.signaled = false;
                return None;
            }
            if t.signaled {
                return None;
            }
            t.signaled = true;
            Some(cur)
        });
        if let Some(overlap) = send {
            send_track(wk, overlap);
        }
    }

    /// Start the per-frame keyboard tracker (idempotent).
    fn start_tracking() {
        if !LINK.load(Ordering::Acquire).is_null() {
            return;
        }
        let observer = OBSERVER.load(Ordering::Acquire);
        if observer.is_null() {
            return;
        }
        let Some(link_class) = AnyClass::get(c"CADisplayLink") else {
            return;
        };
        unsafe {
            let link: *mut AnyObject = msg_send![link_class, displayLinkWithTarget: observer, selector: sel!(k2KeyboardTick:)];
            if link.is_null() {
                return;
            }
            let run_loop: *mut AnyObject = msg_send![class!(NSRunLoop), mainRunLoop];
            if run_loop.is_null() {
                return;
            }
            // Common modes: keep ticking while a scroll view is tracking.
            let _: () = msg_send![link, addToRunLoop: run_loop, forMode: NSRunLoopCommonModes];
            LINK.store(link, Ordering::Release);
        }
        TRACK.with(|t| t.borrow_mut().rebase = true);
    }

    fn stop_tracking() {
        let link = LINK.swap(std::ptr::null_mut(), Ordering::AcqRel);
        if !link.is_null() {
            // The run loop held the only reference: invalidate releases it.
            unsafe {
                let _: () = msg_send![link, invalidate];
            }
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
            set_interactive_dismiss(wk);
            TRACK.with(|t| {
                let mut t = t.borrow_mut();
                t.anim_until = None;
                t.rebase = true;
            });
            start_tracking();
            ping_page(wk);
        }
    }

    extern "C-unwind" fn on_keyboard_did_hide(_this: &AnyObject, _cmd: Sel, _note: *mut AnyObject) {
        stop_tracking();
        if let Some(wk) = live_webview() {
            reset_content_offset(wk);
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
            builder.add_method(
                sel!(k2KeyboardDidHide:),
                on_keyboard_did_hide as extern "C-unwind" fn(_, _, _),
            );
            builder.add_method(
                sel!(k2KeyboardTick:),
                on_keyboard_tick as extern "C-unwind" fn(_, _, _),
            );
            builder.add_method(
                sel!(k2KeyboardWillChange:),
                on_keyboard_will_change as extern "C-unwind" fn(_, _, _),
            );
            builder.add_method(
                sel!(k2KeyboardWillHide:),
                on_keyboard_will_hide as extern "C-unwind" fn(_, _, _),
            );
        }
        let cls = builder.register();
        unsafe {
            // Lives for the process (never released): the center keeps a
            // weak reference.
            let observer: *mut AnyObject = msg_send![cls, new];
            if observer.is_null() {
                return;
            }
            OBSERVER.store(observer, Ordering::Release);
            let center: *mut AnyObject = msg_send![class!(NSNotificationCenter), defaultCenter];
            if center.is_null() {
                return;
            }
            let none = std::ptr::null::<AnyObject>();
            let _: () = msg_send![center, addObserver: observer, selector: sel!(k2KeyboardDidShow:), name: UIKeyboardDidShowNotification, object: none];
            let _: () = msg_send![center, addObserver: observer, selector: sel!(k2KeyboardDidHide:), name: UIKeyboardDidHideNotification, object: none];
            let _: () = msg_send![center, addObserver: observer, selector: sel!(k2ResetViewport:), name: UIApplicationDidBecomeActiveNotification, object: none];
            let _: () = msg_send![center, addObserver: observer, selector: sel!(k2KeyboardWillChange:), name: UIKeyboardWillShowNotification, object: none];
            let _: () = msg_send![center, addObserver: observer, selector: sel!(k2KeyboardWillChange:), name: UIKeyboardWillChangeFrameNotification, object: none];
            let _: () = msg_send![center, addObserver: observer, selector: sel!(k2KeyboardWillHide:), name: UIKeyboardWillHideNotification, object: none];
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
                    // Native per-frame keyboard top during an interactive
                    // dismiss (overlap px).
                    if (typeof window.__k2KeyboardTrack !== 'function') {
                        window.__k2KeyboardTrack = function(h) {
                            window.dispatchEvent(new CustomEvent('k2-keyboard-track', { detail: { height: h } }));
                        };
                    }

                    window.__k2ViewportPing = function() {
                        var vv = window.visualViewport;
                        lastHeight = vv ? vv.height : window.innerHeight;
                        window.dispatchEvent(new CustomEvent('k2-viewport-resize', { detail: { height: lastHeight } }));
                        window.dispatchEvent(new Event('k2-viewport-resync'));
                    };

                    // Native UIKeyboardWill*: where the keyboard is heading
                    // and its timing (useViewportHeight eases with it).
                    if (typeof window.__k2KeyboardWill !== 'function') {
                        window.__k2KeyboardWill = function(d) {
                            window.dispatchEvent(new CustomEvent('k2-keyboard-will', { detail: d }));
                        };
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

/// The composer's height (px) as the scroll views' keyboardDismissPadding
/// (iOS 17+): an interactive dismiss drag starts at the composer's top.
/// Returns whether this iOS supports it (false elsewhere).
#[tauri::command]
fn ios_keyboard_dismiss_padding(px: f64, webview: tauri::WebviewWindow) -> bool {
    #[cfg(target_os = "ios")]
    {
        let supported = ios_keyboard::dismiss_padding_supported();
        if supported {
            let _ = webview.with_webview(move |wv| {
                ios_keyboard::set_dismiss_padding(wv.inner(), px);
            });
        }
        supported
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (px, webview);
        false
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

/// The APNs environment this build's push token belongs to. Xcode Debug
/// signs with the `.debug` entitlements (`aps-environment` development);
/// Release / the App Store archive signs production. Tauri's Xcode build
/// script compiles Rust with the matching cargo profile, so
/// `debug_assertions` follows the Xcode configuration. Push registration
/// sends it only to a daemon advertising `push-environment-v1`.
#[tauri::command]
fn aps_environment() -> &'static str {
    if cfg!(debug_assertions) {
        "development"
    } else {
        "production"
    }
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
            ios_keyboard_dismiss_padding,
            open_external_url,
            aps_environment
        ])
        .run(tauri::generate_context!())
        .expect("error while running K2 Companion");
}
