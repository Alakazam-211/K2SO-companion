/// The interactive-dismiss sampler's decisions, platform-free (tested on
/// the host). Fed one reading per display frame while a pan that began
/// with the keyboard up is in progress: it says when to post a sample and
/// when to stop. A keyboard that does not move posts nothing.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub(crate) mod kb_sampler {
    /// Samples posted at the start of an excursion from rest.
    pub const EARLY_SAMPLES: u32 = 4;
    /// One more sample this long (ms) into the excursion.
    pub const LATE_SAMPLE_MS: f64 = 100.0;
    /// Pan over and the keyboard still this many frames: stop.
    pub const IDLE_STOP_FRAMES: u32 = 8;
    /// Smaller changes (px) are noise.
    pub const MOVE_EPS: f64 = 0.5;

    #[derive(Debug, Default, Clone, Copy, PartialEq)]
    pub struct Frame {
        pub sample: bool,
        pub stop: bool,
    }

    #[derive(Debug, Default)]
    pub struct Sampler {
        rest: Option<f64>,
        prev: Option<f64>,
        move_start_ms: Option<f64>,
        early_sent: u32,
        late_sent: bool,
        idle: u32,
    }

    impl Sampler {
        pub fn reset(&mut self) {
            *self = Self::default();
        }

        /// One frame: `overlap` = keyboard overlap now (None: unknown),
        /// `now_ms` since the run started, `pan_active` = finger down.
        pub fn frame(&mut self, overlap: Option<f64>, now_ms: f64, pan_active: bool) -> Frame {
            let mut out = Frame::default();
            match overlap {
                None => self.idle += 1,
                Some(cur) => {
                    let rest = *self.rest.get_or_insert(cur);
                    let still = self.prev.map_or(true, |p| (cur - p).abs() < MOVE_EPS);
                    self.prev = Some(cur);
                    if still {
                        self.idle += 1;
                    } else {
                        self.idle = 0;
                    }
                    if (cur - rest).abs() >= MOVE_EPS {
                        let start = *self.move_start_ms.get_or_insert(now_ms);
                        if self.early_sent < EARLY_SAMPLES {
                            self.early_sent += 1;
                            out.sample = true;
                        } else if !self.late_sent && now_ms - start >= LATE_SAMPLE_MS {
                            self.late_sent = true;
                            out.sample = true;
                        }
                    } else {
                        // Back at rest: the next excursion samples afresh.
                        self.move_start_ms = None;
                        self.early_sent = 0;
                        self.late_sent = false;
                    }
                }
            }
            if !pan_active && self.idle >= IDLE_STOP_FRAMES {
                out.stop = true;
            }
            out
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn a_static_keyboard_posts_nothing_and_stops_after_the_pan() {
            let mut s = Sampler::default();
            for i in 0..120 {
                let f = s.frame(Some(336.0), i as f64 * 16.7, true);
                assert!(!f.sample, "frame {i}");
                assert!(!f.stop, "frame {i}: pan still active");
            }
            let mut stopped = false;
            for i in 0..IDLE_STOP_FRAMES {
                let f = s.frame(Some(336.0), 2000.0 + i as f64 * 16.7, false);
                assert!(!f.sample);
                stopped |= f.stop;
            }
            assert!(stopped);
        }

        #[test]
        fn an_excursion_posts_the_early_frames_then_one_late_sample() {
            let mut s = Sampler::default();
            let mut posted = vec![];
            let mut t = 0.0;
            let mut k = 336.0;
            s.frame(Some(k), t, true); // rest
            for _ in 0..30 {
                t += 16.7;
                k -= 6.0; // the finger pulls it down
                if s.frame(Some(k), t, true).sample {
                    posted.push(t);
                }
            }
            assert_eq!(posted.len() as u32, EARLY_SAMPLES + 1);
            let start = posted[0];
            assert!(posted[..EARLY_SAMPLES as usize]
                .windows(2)
                .all(|w| (w[1] - w[0] - 16.7).abs() < 1e-6));
            assert!(posted[EARLY_SAMPLES as usize] - start >= LATE_SAMPLE_MS);
        }

        #[test]
        fn back_at_rest_re_arms_and_a_moving_keyboard_never_stops() {
            let mut s = Sampler::default();
            s.frame(Some(336.0), 0.0, true);
            assert!(s.frame(Some(330.0), 16.0, true).sample);
            s.frame(Some(336.0), 32.0, true); // back up
            assert!(s.frame(Some(320.0), 48.0, true).sample);
            // Pan over but the keyboard still moving (no Will* yet): run on.
            for i in 0..20 {
                let f = s.frame(Some(300.0 - i as f64), 64.0 + i as f64 * 16.0, false);
                assert!(!f.stop);
            }
        }

        #[test]
        fn unknown_readings_count_as_idle() {
            let mut s = Sampler::default();
            let mut stop = false;
            for i in 0..IDLE_STOP_FRAMES {
                let f = s.frame(None, i as f64, false);
                assert!(!f.sample);
                stop |= f.stop;
            }
            assert!(stop);
        }
    }
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
        static UIKeyboardFrameBeginUserInfoKey: *const AnyObject;
        static UIApplicationDidBecomeActiveNotification: *const AnyObject;
        static UIApplicationWillResignActiveNotification: *const AnyObject;
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
        // Where the keyboard is as this animation begins (web view px from
        // the top): after an interactive drag, where the finger left it.
        let mut from_top: Option<f64> = None;
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
                let fb: *mut AnyObject =
                    msg_send![info, objectForKey: UIKeyboardFrameBeginUserInfoKey];
                if !fb.is_null() {
                    let begin: CGRect = msg_send![fb, CGRectValue];
                    let b: CGRect = msg_send![wk, bounds];
                    let o = keyboard_overlap(wk, begin);
                    if o > 0.0 {
                        from_top = Some(b.size.height - o);
                    }
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
        // Wall-clock ms with sub-ms precision (the page compares it with
        // performance.timeOrigin + now).
        let at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0);
        let show = !hiding && overlap > 0.0;
        // The keyboard moves on its own now (a release, or a plain show /
        // hide): any dismiss sampling is over — unless the drag recorder
        // is on and a drag was being sampled: it records the release
        // animation too, then stops.
        // The dragged list's offset now (same frame as this Will*): the page
        // places the real composer exactly where its copy is drawn.
        let pan_scroll: Option<f64> = TRACK.with(|t| {
            t.borrow().pan_view.as_ref().map(|v| unsafe {
                let p: CGPoint = msg_send![&**v, contentOffset];
                p.y
            })
        });
        if !rec_tail(duration_ms) {
            stop_sampling();
        }
        // The scroll views get interactive dismiss on DidShow (one walk
        // per show), not on every Will* (WillShow + WillChangeFrame).
        KEYBOARD_UP.store(show, Ordering::Release);
        let from = match from_top {
            Some(v) if v.is_finite() => format!("{:.2}", v),
            _ => "null".to_string(),
        };
        let scroll = match pan_scroll {
            Some(v) if v.is_finite() => format!("{:.2}", v),
            _ => "null".to_string(),
        };
        diag(format!(
            "keyboard will {} · overlap={:.0} from={} · {:.0}ms · active={}",
            if hiding { "hide" } else if show { "show" } else { "change" },
            overlap,
            from,
            duration_ms,
            app_active()
        ));
        let js = format!(
            "window.__k2KeyboardWill && window.__k2KeyboardWill({{height:{:.1},duration:{:.0},curve:{},show:{},at:{:.2},fromTop:{},scrollY:{},active:{}}});",
            overlap, duration_ms, curve, show, at, from, scroll, app_active()
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
    // height, set from the page: ios_keyboard_dismiss_padding).
    //
    // Idle by default: nothing runs while the keyboard just sits there.
    // Every child scroll view's panGestureRecognizer gets a target; a pan
    // that BEGINS while the keyboard is up starts a CADisplayLink sampler.
    // It reads the keyboard's top each frame but posts only when the
    // keyboard has left its rest: the first EARLY_SAMPLES frames of the
    // excursion and one ~LATE_SAMPLE_MS later
    // (`window.__k2KeyboardSample({top, scrollY, t})`, with the panning
    // scroll view's contentOffset.y in the same frame). The page uses them
    // to place the composer copy exactly on the keyboard (one or two
    // corrections) and the first as a fallback attach trigger. It stops
    // when the pan has ended and the keyboard has been still for
    // IDLE_STOP_FRAMES, on any Will* (the release animation takes over,
    // keyboard_will) and on DidHide.
    //
    // Keyboard top: UIKeyboardLayoutGuide (public, iOS 15+) first. If it
    // sits still while the keyboard's host view moves (it did not follow
    // the interactive drag), the host view's frame is used: found by
    // class name in the scene's windows, only its public geometry read.
    // Absent views / selectors just mean no tracking.

    const UI_SCROLL_VIEW_KEYBOARD_DISMISS_MODE_INTERACTIVE: isize = 2;
    const UI_GESTURE_STATE_BEGAN: isize = 1;
    const UI_GESTURE_STATE_ENDED: isize = 3;
    const UI_GESTURE_STATE_CANCELLED: isize = 4;
    const UI_GESTURE_STATE_FAILED: isize = 5;

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

    /// Store the padding; with the keyboard up, apply it to the live web
    /// view's scroll views now (else the next DidShow walk applies it).
    pub fn set_dismiss_padding(webview_ptr: *mut std::ffi::c_void, px: f64) {
        let px = if px.is_finite() { px.clamp(0.0, 400.0) } else { 0.0 };
        let was = DISMISS_PADDING.swap(px.to_bits(), Ordering::AcqRel);
        if was == px.to_bits() || !KEYBOARD_UP.load(Ordering::Acquire) {
            return;
        }
        let wk: *mut AnyObject = webview_ptr.cast();
        if !wk.is_null() {
            set_interactive_dismiss(wk);
        }
    }
    use std::sync::atomic::AtomicBool;

    use crate::kb_sampler::Sampler;

    static OBSERVER: AtomicPtr<AnyObject> = AtomicPtr::new(std::ptr::null_mut());
    static LINK: AtomicPtr<AnyObject> = AtomicPtr::new(std::ptr::null_mut());
    /// The keyboard is up (a Will*Show / DidShow, until a Will*Hide).
    static KEYBOARD_UP: AtomicBool = AtomicBool::new(false);
    /// A scroll view's pan is in progress (began … ended).
    static PAN_ACTIVE: AtomicBool = AtomicBool::new(false);
    /// We hold WebKit's focused state while the app is away (see hold_focus).
    static FOCUS_HELD: AtomicBool = AtomicBool::new(false);

    // ── Drag recorder hook (diagnostics; off by default) ─────────────
    //
    // Server settings → Diagnostics → "Keyboard drag recorder" turns it on
    // (ios_keyboard_recorder). Only while it is on AND a dismiss drag is
    // being sampled, every frame also posts
    // `window.__k2KeyboardRec({t, top, scrollY})` (src/lib/kbDragRecorder.ts),
    // and the sampler keeps running through the release animation (+150ms)
    // instead of stopping on the Will*. Off: exactly the sampler above.
    static RECORDING: AtomicBool = AtomicBool::new(false);

    pub fn set_recording(on: bool) {
        RECORDING.store(on, Ordering::Release);
    }

    /// A Will* while recording a sampled drag: keep the link for the
    /// release animation. True when the tail took over (do not stop).
    fn rec_tail(duration_ms: f64) -> bool {
        if !RECORDING.load(Ordering::Acquire) || LINK.load(Ordering::Acquire).is_null() {
            return false;
        }
        let ms = if duration_ms.is_finite() { duration_ms.clamp(0.0, 1000.0) } else { 250.0 };
        TRACK.with(|t| {
            t.borrow_mut().tail_until = Some(
                std::time::Instant::now() + std::time::Duration::from_millis(ms as u64 + 150),
            );
        });
        true
    }

    fn send_rec(wk: *mut AnyObject, overlap: f64, scroll_y: Option<f64>) {
        let height = unsafe {
            let b: CGRect = msg_send![wk, bounds];
            b.size.height
        };
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0);
        let scroll = match scroll_y {
            Some(y) if y.is_finite() => format!("{:.1}", y),
            _ => "null".to_string(),
        };
        let js = format!(
            "window.__k2KeyboardRec && window.__k2KeyboardRec({{top:{:.1},scrollY:{},t:{:.2}}});",
            height - overlap,
            scroll,
            t
        );
        eval_js(wk, &js);
    }

    #[derive(Clone, Copy, PartialEq)]
    enum TrackSource {
        Guide,
        Host,
    }

    struct Track {
        /// First frame of a sampling run: take the readings as baseline.
        fresh: bool,
        prev_guide: f64,
        prev_host: f64,
        source: TrackSource,
        guide_configured: bool,
        sampler: Sampler,
        /// The scroll view whose pan started this run (its contentOffset
        /// goes with each sample).
        pan_view: Option<objc2::rc::Retained<AnyObject>>,
        started: Option<std::time::Instant>,
        /// Recorder only: the release animation is being recorded until then.
        tail_until: Option<std::time::Instant>,
        /// The keyboard's host view and its window, found once per run
        /// (not by searching the scene's windows every frame).
        host: Option<(objc2::rc::Retained<AnyObject>, objc2::rc::Retained<AnyObject>)>,
    }

    thread_local! {
        // Main thread only (notifications, gestures, display link).
        static TRACK: RefCell<Track> = RefCell::new(Track {
            fresh: true,
            prev_guide: 0.0,
            prev_host: 0.0,
            source: TrackSource::Guide,
            guide_configured: false,
            sampler: Sampler::default(),
            pan_view: None,
            started: None,
            tail_until: None,
            host: None,
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
                // Know when a drag that may dismiss the keyboard starts.
                let observer = OBSERVER.load(Ordering::Acquire);
                if !observer.is_null() {
                    let pan: *mut AnyObject = msg_send![view, panGestureRecognizer];
                    if !pan.is_null() {
                        // remove + add: idempotent across walks.
                        let _: () = msg_send![pan, removeTarget: observer, action: sel!(k2Pan:)];
                        let _: () = msg_send![pan, addTarget: observer, action: sel!(k2Pan:)];
                    }
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

    /// The keyboard's host view (and its window) in the web view's scene,
    /// by class name; None when there is none.
    fn find_keyboard_host(wk: *mut AnyObject) -> Option<(*mut AnyObject, *mut AnyObject)> {
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
                let screen: *mut AnyObject = msg_send![w, screen];
                if screen.is_null() {
                    continue;
                }
                if let Some(host) = find_view_named(w, b"UIInputSetHostView", 0) {
                    return Some((host, w));
                }
            }
            None
        }
    }

    /// Keyboard overlap of the web view per a host view found by
    /// `find_keyboard_host`; None once it left its window (re-find then).
    fn host_overlap_of(wk: *mut AnyObject, host: *mut AnyObject, w: *mut AnyObject) -> Option<f64> {
        unsafe {
            let in_w: *mut AnyObject = msg_send![host, window];
            if in_w != w {
                return None;
            }
            let hb: CGRect = msg_send![host, bounds];
            if hb.size.height <= 0.0 {
                return None;
            }
            let in_window: CGRect =
                msg_send![host, convertRect: hb, toView: std::ptr::null_mut::<AnyObject>()];
            let screen: *mut AnyObject = msg_send![w, screen];
            if screen.is_null() {
                return None;
            }
            let space: *mut AnyObject = msg_send![screen, coordinateSpace];
            if space.is_null() {
                return None;
            }
            let on_screen: CGRect = msg_send![w, convertRect: in_window, toCoordinateSpace: space];
            Some(keyboard_overlap(wk, on_screen))
        }
    }

    /// Keyboard overlap of the web view per the keyboard's host view: the
    /// one cached for this sampling run while it is still in place, else
    /// found again (and cached).
    fn host_overlap(wk: *mut AnyObject) -> Option<f64> {
        let cached = TRACK.with(|t| {
            t.borrow()
                .host
                .as_ref()
                .map(|(h, w)| (objc2::rc::Retained::as_ptr(h) as *mut AnyObject, objc2::rc::Retained::as_ptr(w) as *mut AnyObject))
        });
        if let Some((h, w)) = cached {
            if let Some(o) = host_overlap_of(wk, h, w) {
                return Some(o);
            }
        }
        let found = find_keyboard_host(wk);
        let retained = found.and_then(|(h, w)| unsafe {
            Some((objc2::rc::Retained::retain(h)?, objc2::rc::Retained::retain(w)?))
        });
        TRACK.with(|t| t.borrow_mut().host = retained);
        let (h, w) = found?;
        host_overlap_of(wk, h, w)
    }

    /// One sample to the page: the keyboard's top (web view px) and the
    /// panning scroll view's contentOffset.y, read in the same frame.
    fn send_sample(wk: *mut AnyObject, overlap: f64, scroll_y: Option<f64>) {
        let height = unsafe {
            let b: CGRect = msg_send![wk, bounds];
            b.size.height
        };
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0);
        let scroll = match scroll_y {
            Some(y) if y.is_finite() => format!("{:.2}", y),
            _ => "null".to_string(),
        };
        let js = format!(
            "window.__k2KeyboardSample && window.__k2KeyboardSample({{top:{:.2},scrollY:{},t:{:.1}}});",
            height - overlap,
            scroll,
            t
        );
        eval_js(wk, &js);
    }

    extern "C-unwind" fn on_pan(_this: &AnyObject, _cmd: Sel, pan: *mut AnyObject) {
        if pan.is_null() {
            return;
        }
        let state: isize = unsafe { msg_send![pan, state] };
        if state == UI_GESTURE_STATE_BEGAN {
            if !KEYBOARD_UP.load(Ordering::Acquire) {
                return;
            }
            PAN_ACTIVE.store(true, Ordering::Release);
            let view: *mut AnyObject = unsafe { msg_send![pan, view] };
            let retained = unsafe { objc2::rc::Retained::retain(view) };
            TRACK.with(|t| t.borrow_mut().pan_view = retained);
            start_sampling();
        } else if state == UI_GESTURE_STATE_ENDED
            || state == UI_GESTURE_STATE_CANCELLED
            || state == UI_GESTURE_STATE_FAILED
        {
            PAN_ACTIVE.store(false, Ordering::Release);
        }
    }

    extern "C-unwind" fn on_keyboard_tick(_this: &AnyObject, _cmd: Sel, _link: *mut AnyObject) {
        let Some(wk) = live_webview() else {
            stop_sampling();
            return;
        };
        let configure = TRACK.with(|t| {
            let mut t = t.borrow_mut();
            let c = !t.guide_configured;
            t.guide_configured = true;
            c
        });
        let guide = guide_overlap(wk, configure);
        let host = host_overlap(wk);
        let pan_active = PAN_ACTIVE.load(Ordering::Acquire);
        let recording = RECORDING.load(Ordering::Acquire);
        let (out, overlap, scroll_y, rec_scroll) = TRACK.with(|t| {
            let mut t = t.borrow_mut();
            let now_ms = t
                .started
                .map_or(0.0, |s| s.elapsed().as_secs_f64() * 1000.0);
            if t.fresh {
                t.fresh = false;
                if let Some(g) = guide {
                    t.prev_guide = g;
                }
                if let Some(h) = host {
                    t.prev_host = h;
                }
                t.source = TrackSource::Guide;
            } else {
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
            }
            let cur = match t.source {
                TrackSource::Guide => guide.or(host),
                TrackSource::Host => host.or(guide),
            };
            fn offset(t: &Track) -> Option<f64> {
                t.pan_view.as_ref().map(|v| unsafe {
                    let p: CGPoint = msg_send![&**v, contentOffset];
                    p.y
                })
            }
            if let Some(until) = t.tail_until {
                // Recorder tail: no samples (the Will* owns the keyboard).
                let stop = std::time::Instant::now() >= until;
                let out = kb_sampler_frame_stop(stop);
                return (out, cur, None, offset(&t));
            }
            let out = t.sampler.frame(cur, now_ms, pan_active);
            let scroll_y = if out.sample { offset(&t) } else { None };
            let rec_scroll = if recording { offset(&t) } else { None };
            (out, cur, scroll_y, rec_scroll)
        });
        if recording {
            if let Some(overlap) = overlap {
                send_rec(wk, overlap, rec_scroll);
            }
        }
        if out.sample {
            if let Some(overlap) = overlap {
                send_sample(wk, overlap, scroll_y);
            }
        }
        if out.stop {
            stop_sampling();
        }
    }

    /// Start the dismiss sampler (idempotent): only while a pan that began
    /// with the keyboard up is (or was just) in progress.
    fn start_sampling() {
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
        TRACK.with(|t| {
            let mut t = t.borrow_mut();
            t.fresh = true;
            t.sampler.reset();
            t.started = Some(std::time::Instant::now());
            t.host = None;
        });
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
    }

    fn kb_sampler_frame_stop(stop: bool) -> crate::kb_sampler::Frame {
        crate::kb_sampler::Frame { sample: false, stop }
    }

    fn stop_sampling() {
        let link = LINK.swap(std::ptr::null_mut(), Ordering::AcqRel);
        if !link.is_null() {
            // The run loop held the only reference: invalidate releases it.
            unsafe {
                let _: () = msg_send![link, invalidate];
            }
        }
        TRACK.with(|t| {
            let mut t = t.borrow_mut();
            t.pan_view = None;
            t.started = None;
            t.tail_until = None;
            t.host = None;
        });
    }

    /// True while the app is in the foreground (UIApplicationStateActive).
    /// A keyboard hide that comes from the app leaving the screen (Home,
    /// app switcher, lock) must not end the input session from here: in the
    /// background UIKit's keyboard task queue can wait forever on a
    /// programmatic focus change, which hangs the main thread until the
    /// watchdog kills the app (0x8BADF00D, TestFlight 202610181404). iOS
    /// puts the keyboard back on its own when the app returns.
    fn app_active() -> bool {
        unsafe {
            let app: *mut AnyObject = msg_send![class!(UIApplication), sharedApplication];
            if app.is_null() {
                return true;
            }
            let state: i64 = msg_send![app, applicationState];
            state == 0
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
            diag(format!("keyboard did show · {}", keyboard_frame_str(wk)));
            KEYBOARD_UP.store(true, Ordering::Release);
            set_interactive_dismiss(wk);
            ping_page(wk);
        }
    }

    extern "C-unwind" fn on_keyboard_did_hide(_this: &AnyObject, _cmd: Sel, _note: *mut AnyObject) {
        // A Will*Show since this hide began (a field tapped mid-animation):
        // the keyboard is coming back — leave its session alone.
        let coming_back = KEYBOARD_UP.load(Ordering::Acquire);
        PAN_ACTIVE.store(false, Ordering::Release);
        // A recorder tail ends itself (it records the keyboard settling).
        let tail = TRACK.with(|t| t.borrow().tail_until.is_some());
        if !tail {
            stop_sampling();
        }
        if let Some(wk) = live_webview() {
            diag(format!("keyboard did hide · retaining={}", retaining_str(wk)));
            if !coming_back && app_active() {
                // The keyboard is gone. If it went by an interactive dismiss
                // (or on its own), WebKit's content view can still be the
                // first responder with its input view hidden: the next tap on
                // a field focuses it (the page sees focus) but UIKit never
                // shows the keyboard again (TestFlight 1446, Tickets). Resign
                // it, as UIKit does for a native field; a no-op when the page
                // blurred the field itself.
                unsafe {
                    let _: bool = msg_send![wk, endEditing: true];
                }
            }
            reset_content_offset(wk);
            ping_page(wk);
        }
    }

    extern "C-unwind" fn on_reset(_this: &AnyObject, _cmd: Sel, _note: *mut AnyObject) {
        if let Some(wk) = live_webview() {
            diag(format!(
                "app did become active · held={} · retaining={}",
                FOCUS_HELD.load(Ordering::Acquire),
                retaining_str(wk)
            ));
            reset_content_offset(wk);
            ping_page(wk);
        }
        // Back in the foreground: WebKit sees the app as focused again by
        // itself; hand its focus state back once the keyboard has settled.
        if FOCUS_HELD.load(Ordering::Acquire) {
            let observer = OBSERVER.load(Ordering::Acquire);
            if !observer.is_null() {
                unsafe {
                    let none = std::ptr::null::<AnyObject>();
                    let _: () = msg_send![observer, performSelector: sel!(k2ReleaseFocusHold:), withObject: none, afterDelay: FOCUS_RELEASE_S];
                }
            } else {
                release_focus_hold();
            }
        }
    }

    // ── Keyboard as left, on return ──────────────────────────────────
    //
    // A native app comes back with its keyboard already up: the field never
    // stops being first responder and UIKit restores the keyboard from a
    // snapshot. WKWebView instead unfocuses the page when the app goes to the
    // background (`PageClientImpl::isViewFocused` is false while
    // `_isBackground`): the DOM gets `blur`, the input session ends and the
    // keyboard hides; on return WebKit refocuses the field and presents the
    // keyboard as a fresh, animated focus (its `_restoreFocusWithToken:`
    // opts out of UIKit's restore). Nothing in the page can stop that.
    //
    // WebKit's own way to keep its focused state across such moments (it
    // uses it for its form-control overlays) is a hold counter on the
    // WKWebView: while held, `isViewFocused` / `isViewWindowActive` stay
    // true, so no blur, no refocus, and UIKit's own restore applies. We take
    // it on WillResignActive when the keyboard is up (left closed, it stays
    // closed) and give it back FOCUS_RELEASE_S after DidBecomeActive.
    // A blur while held resets the count inside WebKit, and WebKit documents
    // the decrement as harmless after a reset. These are WKWebView SPI:
    // checked with respondsToSelector, so a WebKit without them just keeps
    // today's behaviour. Also no focus change happens in the background any
    // more (the 0x8BADF00D hang above came from one).

    /// Seconds after DidBecomeActive before the hold is given back.
    const FOCUS_RELEASE_S: f64 = 1.0;

    fn responds(obj: *mut AnyObject, sel: Sel) -> bool {
        unsafe { msg_send![obj, respondsToSelector: sel] }
    }

    /// Hold WebKit's focused state (no-op if already held or unsupported).
    fn hold_focus(wk: *mut AnyObject) {
        if FOCUS_HELD.load(Ordering::Acquire) || !RETURN_HOLD_ON.load(Ordering::Acquire) {
            return;
        }
        if !responds(wk, sel!(_incrementFocusPreservationCount))
            || !responds(wk, sel!(_decrementFocusPreservationCount))
        {
            return;
        }
        unsafe {
            let _: () = msg_send![wk, _incrementFocusPreservationCount];
        }
        FOCUS_HELD.store(true, Ordering::Release);
        diag(format!("hold focus · retaining={}", retaining_str(wk)));
    }

    /// Give the hold back (once).
    fn release_focus_hold() {
        if !FOCUS_HELD.swap(false, Ordering::AcqRel) {
            return;
        }
        if let Some(wk) = live_webview() {
            unsafe {
                let _: () = msg_send![wk, _decrementFocusPreservationCount];
            }
            // UIKit's own background save (`_preserveFocusWithToken:`)
            // adds to the same counter, and its matching restore may never
            // run when focus never left: a leftover count keeps WebKit
            // treating the view as focused, so a later blur would not end
            // editing. Clear it, as WebKit itself does on every blur. Active
            // and no focus change: safe (cf. the hang above).
            let before = retaining_str(wk);
            if retaining(wk) == Some(true)
                && responds(wk, sel!(_resetFocusPreservationCountAndReleaseActiveFocusState))
            {
                unsafe {
                    let _: () = msg_send![wk, _resetFocusPreservationCountAndReleaseActiveFocusState];
                }
            }
            diag(format!("release hold · retaining {} → {}", before, retaining_str(wk)));
        }
    }

    extern "C-unwind" fn on_will_resign_active(_this: &AnyObject, _cmd: Sel, _note: *mut AnyObject) {
        diag(format!(
            "app will resign active · keyboardUp={} · retaining={}",
            KEYBOARD_UP.load(Ordering::Acquire),
            live_webview().map(retaining_str).unwrap_or("?")
        ));
        if !KEYBOARD_UP.load(Ordering::Acquire) {
            return;
        }
        if let Some(wk) = live_webview() {
            hold_focus(wk);
        }
    }

    // ── Diagnostics: keyboard events (Server settings → Diagnostics) ───
    //
    // A short, content-free log of the app / keyboard lifecycle and of
    // WebKit's focus-hold state, for comparing behaviour on a device
    // (src/lib/kbDiag.ts; the page adds marks such as a swipe's start).
    // Plus the switch for the return hold above (on by default).

    static RETURN_HOLD_ON: AtomicBool = AtomicBool::new(true);
    static DIAG: std::sync::Mutex<std::collections::VecDeque<String>> =
        std::sync::Mutex::new(std::collections::VecDeque::new());
    const DIAG_MAX: usize = 80;

    fn diag(line: String) {
        static T0: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
        let t = T0.get_or_init(std::time::Instant::now).elapsed().as_secs_f64();
        if let Ok(mut q) = DIAG.lock() {
            if q.len() >= DIAG_MAX {
                q.pop_front();
            }
            q.push_back(format!("{:>9.3}s  {}", t, line));
        }
    }

    /// WebKit's "treat the view as focused" state; None if unknown.
    fn retaining(wk: *mut AnyObject) -> Option<bool> {
        if !responds(wk, sel!(_isRetainingActiveFocusedState)) {
            return None;
        }
        Some(unsafe { msg_send![wk, _isRetainingActiveFocusedState] })
    }

    fn retaining_str(wk: *mut AnyObject) -> &'static str {
        match retaining(wk) {
            Some(true) => "yes",
            Some(false) => "no",
            None => "?",
        }
    }

    /// The keyboard host view's frame on screen, or "no keyboard".
    fn keyboard_frame_str(wk: *mut AnyObject) -> String {
        let Some((host, _w)) = find_keyboard_host(wk) else {
            return "no keyboard host".into();
        };
        unsafe {
            let b: CGRect = msg_send![host, bounds];
            let none = std::ptr::null::<AnyObject>();
            let r: CGRect = msg_send![host, convertRect: b, toView: none];
            format!(
                "keyboard x={:.0} y={:.0} w={:.0} h={:.0}",
                r.origin.x, r.origin.y, r.size.width, r.size.height
            )
        }
    }

    pub fn set_return_hold(on: bool) {
        RETURN_HOLD_ON.store(on, Ordering::Release);
        diag(format!("return hold {}", if on { "on" } else { "off" }));
    }

    /// A page mark (e.g. "swipe start") with the state at that moment.
    pub fn diag_mark(webview_ptr: *mut std::ffi::c_void, label: &str) {
        let wk: *mut AnyObject = webview_ptr.cast();
        let label: String = label.chars().filter(|c| !c.is_control()).take(80).collect();
        diag(format!(
            "page: {} · retaining={} · held={} · {}",
            label,
            retaining_str(wk),
            FOCUS_HELD.load(Ordering::Acquire),
            keyboard_frame_str(wk)
        ));
    }

    /// The log, oldest first, plus a header with the current state.
    pub fn diag_report(webview_ptr: *mut std::ffi::c_void) -> String {
        let wk: *mut AnyObject = webview_ptr.cast();
        let mut out = format!(
            "now: retaining={} · held={} · returnHold={} · keyboardUp={} · active={} · {}\n",
            retaining_str(wk),
            FOCUS_HELD.load(Ordering::Acquire),
            RETURN_HOLD_ON.load(Ordering::Acquire),
            KEYBOARD_UP.load(Ordering::Acquire),
            app_active(),
            keyboard_frame_str(wk)
        );
        if let Ok(q) = DIAG.lock() {
            for l in q.iter() {
                out.push_str(l);
                out.push('\n');
            }
        }
        out
    }

    pub fn diag_clear() {
        if let Ok(mut q) = DIAG.lock() {
            q.clear();
        }
    }

    extern "C-unwind" fn on_release_focus_hold(_this: &AnyObject, _cmd: Sel, _arg: *mut AnyObject) {
        // Inactive again before the delay ran (a banner, Control Center):
        // keep holding; the next DidBecomeActive schedules this again.
        if app_active() {
            release_focus_hold();
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
                sel!(k2WillResignActive:),
                on_will_resign_active as extern "C-unwind" fn(_, _, _),
            );
            builder.add_method(
                sel!(k2ReleaseFocusHold:),
                on_release_focus_hold as extern "C-unwind" fn(_, _, _),
            );
            builder.add_method(
                sel!(k2KeyboardDidHide:),
                on_keyboard_did_hide as extern "C-unwind" fn(_, _, _),
            );
            builder.add_method(
                sel!(k2KeyboardTick:),
                on_keyboard_tick as extern "C-unwind" fn(_, _, _),
            );
            builder.add_method(sel!(k2Pan:), on_pan as extern "C-unwind" fn(_, _, _));
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
            let _: () = msg_send![center, addObserver: observer, selector: sel!(k2WillResignActive:), name: UIApplicationWillResignActiveNotification, object: none];
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
                    // Keyboard samples during an interactive dismiss drag
                    // ({top, scrollY, t}; useViewportHeight).
                    if (typeof window.__k2KeyboardSample !== 'function') {
                        window.__k2KeyboardSample = function(s) {
                            window.dispatchEvent(new CustomEvent('k2-keyboard-sample', { detail: s }));
                        };
                    }
                    if (typeof window.__k2KeyboardRec !== 'function') {
                        window.__k2KeyboardRec = function(s) {
                            window.dispatchEvent(new CustomEvent('k2-keyboard-rec', { detail: s }));
                        };
                    }
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

/// Diagnostics: the keyboard drag recorder on / off (per-frame keyboard
/// frames during a sampled dismiss drag; src/lib/kbDragRecorder.ts).
#[tauri::command]
fn ios_keyboard_recorder(on: bool) -> bool {
    #[cfg(target_os = "ios")]
    {
        ios_keyboard::set_recording(on);
        true
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = on;
        false
    }
}

/// Diagnostics: keyboard events (src/lib/kbDiag.ts). `action`:
/// "report" → the log; "mark" → add `label`; "hold" → the return hold
/// on / off (`on`); "clear". Empty string off iOS.
#[tauri::command]
async fn ios_keyboard_diag(
    action: String,
    label: Option<String>,
    on: Option<bool>,
    webview: tauri::WebviewWindow,
) -> String {
    #[cfg(target_os = "ios")]
    {
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let _ = webview.with_webview(move |wv| {
            let ptr = wv.inner();
            let out = match action.as_str() {
                "report" => ios_keyboard::diag_report(ptr),
                "mark" => {
                    ios_keyboard::diag_mark(ptr, label.as_deref().unwrap_or(""));
                    String::new()
                }
                "hold" => {
                    ios_keyboard::set_return_hold(on.unwrap_or(true));
                    String::new()
                }
                "clear" => {
                    ios_keyboard::diag_clear();
                    String::new()
                }
                _ => String::new(),
            };
            let _ = tx.send(out);
        });
        rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap_or_default()
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (action, label, on, webview);
        String::new()
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
            ios_strip_accessory_bar,
            ios_keyboard_dismiss_padding,
            ios_keyboard_recorder,
            ios_keyboard_diag,
            open_external_url,
            aps_environment
        ])
        .run(tauri::generate_context!())
        .expect("error while running K2 Companion");
}
