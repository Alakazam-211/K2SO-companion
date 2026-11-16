//! Light, Dark or Auto on the native side (Settings → Themes; the page's
//! src/theme/nativeAppearance.ts calls `set_appearance`).
//!
//! The app used to be locked dark (Info.plist `UIUserInterfaceStyle = Dark`
//! plus an override on every window). The plist lock is gone, so the
//! system's real appearance reaches the app (Auto needs it: WKWebView's
//! `prefers-color-scheme` follows the trait collection, live), and the mode
//! is an `overrideUserInterfaceStyle` on the windows and the web view:
//! Dark → dark, Light → light, Auto → unspecified (follow the iPhone).
//! The keyboard, the status bar text and native sheets follow it.
//!
//! Launch order: the native window exists before any JS runs, and the
//! choice lives in the page's localStorage. So the command also saves the
//! mode and each side's page colour in NSUserDefaults, and the next launch
//! starts from there: `install_early` (run(), before the first window
//! exists) stamps the saved mode on every window as it becomes visible,
//! `apply` (setup) on the web view and its window. Nothing saved (a fresh
//! install, or the first launch of this build) is Dark on black: exactly
//! the old lock. The page re-sends its choice at startup (initTheme), so
//! a lost or stale save corrects itself on the first frame of JS.

/// The chosen mode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Light,
    Dark,
    Auto,
}

impl Mode {
    pub fn parse(s: &str) -> Option<Mode> {
        match s {
            "light" => Some(Mode::Light),
            "dark" => Some(Mode::Dark),
            "auto" => Some(Mode::Auto),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Light => "light",
            Mode::Dark => "dark",
            Mode::Auto => "auto",
        }
    }

    /// UIUserInterfaceStyle: 0 unspecified (follow the system), 1 light,
    /// 2 dark.
    pub fn ui_style(self) -> i64 {
        match self {
            Mode::Auto => 0,
            Mode::Light => 1,
            Mode::Dark => 2,
        }
    }
}

/// sRGB components, 0–1.
pub type Rgb = (f64, f64, f64);

/// `#rgb`, `#rrggbb` or `#rrggbbaa` (alpha ignored: a page colour is
/// opaque).
pub fn parse_hex(s: &str) -> Option<Rgb> {
    let h = s.trim().strip_prefix('#')?;
    if !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let ch = |i: usize, w: usize| -> Option<f64> {
        let v = u8::from_str_radix(&h[i..i + w], 16).ok()?;
        Some(if w == 1 { (v * 17) as f64 / 255.0 } else { v as f64 / 255.0 })
    };
    match h.len() {
        3 => Some((ch(0, 1)?, ch(1, 1)?, ch(2, 1)?)),
        6 | 8 => Some((ch(0, 2)?, ch(2, 2)?, ch(4, 2)?)),
        _ => None,
    }
}

pub fn to_hex((r, g, b): Rgb) -> String {
    let c = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}", c(r), c(g), c(b))
}

/// The old lock's black: what a dark user sees before anything is saved.
pub const DARK_BG_DEFAULT: Rgb = (0.0, 0.0, 0.0);
/// Veil's page (#fafafa).
pub const LIGHT_BG_DEFAULT: Rgb = (250.0 / 255.0, 250.0 / 255.0, 250.0 / 255.0);

/// The mode and each side's page colour.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Appearance {
    pub mode: Mode,
    pub dark_bg: Rgb,
    pub light_bg: Rgb,
}

impl Default for Appearance {
    fn default() -> Self {
        Appearance { mode: Mode::Dark, dark_bg: DARK_BG_DEFAULT, light_bg: LIGHT_BG_DEFAULT }
    }
}

impl Appearance {
    /// From saved (or sent) strings; anything missing or unreadable keeps
    /// `base`'s value.
    pub fn from_strs(base: Appearance, mode: Option<&str>, dark_bg: Option<&str>, light_bg: Option<&str>) -> Self {
        Appearance {
            mode: mode.and_then(Mode::parse).unwrap_or(base.mode),
            dark_bg: dark_bg.and_then(parse_hex).unwrap_or(base.dark_bg),
            light_bg: light_bg.and_then(parse_hex).unwrap_or(base.light_bg),
        }
    }

    /// The page colour shown: Auto picks by the system.
    pub fn bg(&self, system_light: bool) -> Rgb {
        match self.mode {
            Mode::Light => self.light_bg,
            Mode::Dark => self.dark_bg,
            Mode::Auto => {
                if system_light {
                    self.light_bg
                } else {
                    self.dark_bg
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modes_parse_and_map_to_ui_styles() {
        assert_eq!(Mode::parse("light"), Some(Mode::Light));
        assert_eq!(Mode::parse("dark"), Some(Mode::Dark));
        assert_eq!(Mode::parse("auto"), Some(Mode::Auto));
        assert_eq!(Mode::parse("Dark"), None);
        assert_eq!(Mode::Auto.ui_style(), 0);
        assert_eq!(Mode::Light.ui_style(), 1);
        assert_eq!(Mode::Dark.ui_style(), 2);
        for m in [Mode::Light, Mode::Dark, Mode::Auto] {
            assert_eq!(Mode::parse(m.as_str()), Some(m));
        }
    }

    #[test]
    fn hex_colours_parse_and_round_trip() {
        assert_eq!(parse_hex("#000"), Some((0.0, 0.0, 0.0)));
        assert_eq!(parse_hex("#fff"), Some((1.0, 1.0, 1.0)));
        assert_eq!(parse_hex(" #0a0a0a "), Some((10.0 / 255.0, 10.0 / 255.0, 10.0 / 255.0)));
        assert_eq!(parse_hex("#fafafa80").map(to_hex), Some("#fafafa".to_string()));
        assert_eq!(to_hex(parse_hex("#100f0e").unwrap()), "#100f0e");
        assert_eq!(parse_hex("0a0a0a"), None);
        assert_eq!(parse_hex("#12345"), None);
        assert_eq!(parse_hex("#gggggg"), None);
        assert_eq!(parse_hex("rgb(0,0,0)"), None);
        assert_eq!(parse_hex("#ééé"), None);
    }

    #[test]
    fn nothing_saved_is_the_old_dark_lock() {
        let a = Appearance::from_strs(Appearance::default(), None, None, None);
        assert_eq!(a.mode, Mode::Dark);
        assert_eq!(a.bg(true), DARK_BG_DEFAULT);
        assert_eq!(a.bg(false), DARK_BG_DEFAULT);
    }

    #[test]
    fn bad_values_keep_the_base_and_auto_follows_the_system() {
        let a = Appearance::from_strs(Appearance::default(), Some("auto"), Some("#100f0e"), Some("nope"));
        assert_eq!(a.mode, Mode::Auto);
        assert_eq!(to_hex(a.bg(false)), "#100f0e");
        assert_eq!(a.bg(true), LIGHT_BG_DEFAULT);
        let b = Appearance::from_strs(a, Some("bogus"), None, Some("#ffffff"));
        assert_eq!(b.mode, Mode::Auto);
        assert_eq!(to_hex(b.bg(true)), "#ffffff");
        let light = Appearance::from_strs(b, Some("light"), None, None);
        assert_eq!(to_hex(light.bg(false)), "#ffffff");
    }
}

#[cfg(target_os = "ios")]
pub mod ios {
    use super::{to_hex, Appearance, Rgb};
    use objc2::runtime::{AnyClass, AnyObject, ClassBuilder, Sel};
    use objc2::{class, msg_send, sel};
    use std::ffi::{c_char, CStr, CString};
    use std::sync::Mutex;

    const KEY_MODE: &CStr = c"k2.appearance.mode";
    const KEY_DARK_BG: &CStr = c"k2.appearance.darkBg";
    const KEY_LIGHT_BG: &CStr = c"k2.appearance.lightBg";
    const OBSERVER_CLASS_NAME: &CStr = c"K2AppearanceObserver";

    /// UIUserInterfaceStyleLight.
    const UI_STYLE_LIGHT: i64 = 1;

    static CURRENT: Mutex<Option<Appearance>> = Mutex::new(None);

    #[link(name = "UIKit", kind = "framework")]
    extern "C" {
        static UIWindowDidBecomeVisibleNotification: *const AnyObject;
    }

    unsafe fn ns_str(c: &CStr) -> *mut AnyObject {
        msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()]
    }

    unsafe fn defaults() -> *mut AnyObject {
        msg_send![class!(NSUserDefaults), standardUserDefaults]
    }

    fn read(key: &CStr) -> Option<String> {
        unsafe {
            let d = defaults();
            if d.is_null() {
                return None;
            }
            let v: *mut AnyObject = msg_send![d, stringForKey: ns_str(key)];
            if v.is_null() {
                return None;
            }
            let bytes: *const c_char = msg_send![v, UTF8String];
            if bytes.is_null() {
                return None;
            }
            Some(CStr::from_ptr(bytes).to_string_lossy().into_owned())
        }
    }

    fn write(key: &CStr, value: &str) {
        let Ok(c) = CString::new(value) else {
            return;
        };
        unsafe {
            let d = defaults();
            if d.is_null() {
                return;
            }
            let v = ns_str(&c);
            if v.is_null() {
                return;
            }
            let _: () = msg_send![d, setObject: v, forKey: ns_str(key)];
        }
    }

    /// The mode in force: what the page last sent, else what was saved,
    /// else Dark on black.
    pub fn current() -> Appearance {
        let mut slot = CURRENT.lock().unwrap_or_else(|e| e.into_inner());
        *slot.get_or_insert_with(|| {
            Appearance::from_strs(
                Appearance::default(),
                read(KEY_MODE).as_deref(),
                read(KEY_DARK_BG).as_deref(),
                read(KEY_LIGHT_BG).as_deref(),
            )
        })
    }

    /// The page's choice: in force now, and saved for the next launch.
    /// Any thread (NSUserDefaults is thread-safe).
    pub fn set(a: Appearance) {
        *CURRENT.lock().unwrap_or_else(|e| e.into_inner()) = Some(a);
        write(KEY_MODE, a.mode.as_str());
        write(KEY_DARK_BG, &to_hex(a.dark_bg));
        write(KEY_LIGHT_BG, &to_hex(a.light_bg));
    }

    unsafe fn ui_color((r, g, b): Rgb) -> *mut AnyObject {
        msg_send![class!(UIColor), colorWithRed: r, green: g, blue: b, alpha: 1.0f64]
    }

    /// The iPhone's own appearance (no plist lock, and the screen carries
    /// no override).
    fn system_light() -> bool {
        unsafe {
            let screen: *mut AnyObject = msg_send![class!(UIScreen), mainScreen];
            if screen.is_null() {
                return false;
            }
            let traits: *mut AnyObject = msg_send![screen, traitCollection];
            if traits.is_null() {
                return false;
            }
            let style: i64 = msg_send![traits, userInterfaceStyle];
            style == UI_STYLE_LIGHT
        }
    }

    unsafe fn each_window(mut f: impl FnMut(*mut AnyObject)) {
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
                    f(w);
                }
            }
        }
    }

    unsafe fn set_style(view: *mut AnyObject, style: i64) {
        let _: () = msg_send![view, setOverrideUserInterfaceStyle: style];
    }

    /// The mode on the web view, its window and every window of every
    /// scene (the keyboard and the status bar follow), and the page colour
    /// behind the web view. `bg`: the colour the page shows now (sent with
    /// the mode); None picks by the mode and the system. Idempotent; main
    /// thread only.
    pub fn apply(webview_ptr: *mut std::ffi::c_void, bg: Option<Rgb>) {
        let a = current();
        let style = a.mode.ui_style();
        let bg = bg.unwrap_or_else(|| a.bg(system_light()));
        unsafe {
            each_window(|w| set_style(w, style));
            let wk: *mut AnyObject = webview_ptr.cast();
            if wk.is_null() {
                return;
            }
            set_style(wk, style);
            let color = ui_color(bg);
            if !color.is_null() {
                // Seen only before the page paints and in gaps (keyboard
                // moves, rotation): the page's own colour, not black.
                let _: () = msg_send![wk, setBackgroundColor: color];
                let scroll: *mut AnyObject = msg_send![wk, scrollView];
                if !scroll.is_null() {
                    let _: () = msg_send![scroll, setBackgroundColor: color];
                }
            }
            let window: *mut AnyObject = msg_send![wk, window];
            if window.is_null() {
                return;
            }
            set_style(window, style);
            if !color.is_null() {
                let _: () = msg_send![window, setBackgroundColor: color];
            }
            // Status bar text: the root controller's default style follows
            // its traits; ask UIKit to look again.
            let root: *mut AnyObject = msg_send![window, rootViewController];
            if !root.is_null() {
                let _: () = msg_send![root, setNeedsStatusBarAppearanceUpdate];
            }
        }
    }

    extern "C-unwind" fn on_window_visible(_this: &AnyObject, _cmd: Sel, note: *mut AnyObject) {
        unsafe {
            if note.is_null() {
                return;
            }
            let w: *mut AnyObject = msg_send![note, object];
            if w.is_null() {
                return;
            }
            let is_window: bool = msg_send![w, isKindOfClass: class!(UIWindow)];
            if is_window {
                set_style(w, current().mode.ui_style());
            }
        }
    }

    /// Before the first window: every window that becomes visible (the
    /// app's at launch, an iPad's second scene, UIKit's own) takes the
    /// saved mode at once, so a dark user never sees the system's light
    /// for a frame before setup. Call once, early in run().
    pub fn install_early() {
        let _ = current(); // load the saved mode now, off the first frame
        if AnyClass::get(OBSERVER_CLASS_NAME).is_some() {
            return;
        }
        let Some(mut builder) = ClassBuilder::new(OBSERVER_CLASS_NAME, class!(NSObject)) else {
            return;
        };
        unsafe {
            builder.add_method(
                sel!(k2WindowVisible:),
                on_window_visible as extern "C-unwind" fn(_, _, _),
            );
        }
        let cls = builder.register();
        unsafe {
            // Lives for the process: the center keeps a weak reference.
            let observer: *mut AnyObject = msg_send![cls, new];
            if observer.is_null() {
                return;
            }
            let center: *mut AnyObject = msg_send![class!(NSNotificationCenter), defaultCenter];
            if center.is_null() {
                return;
            }
            let none = std::ptr::null::<AnyObject>();
            let _: () = msg_send![center, addObserver: observer, selector: sel!(k2WindowVisible:), name: UIWindowDidBecomeVisibleNotification, object: none];
        }
    }
}
