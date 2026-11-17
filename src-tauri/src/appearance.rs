//! Light, Dark or Auto on the native side (Settings → Themes; the page's
//! src/theme/nativeAppearance.ts calls `set_appearance`).
//!
//! The app used to be locked dark (Info.plist `UIUserInterfaceStyle = Dark`
//! plus an override on every window). The plist lock is gone, so the
//! system's real appearance reaches the app, and the windows and the web
//! view carry an `overrideUserInterfaceStyle`. The keyboard, the status bar
//! text and native sheets and alerts follow it.
//!
//! The override follows the PALETTE ON SCREEN, not the mode (Riley
//! 2026-11-17: Obsidian or Dusk picked for the day side should bring a dark
//! keyboard). Light shows the light side's palette, Dark the dark side's,
//! Auto the side the iPhone is in; that palette's scheme is the style. So
//! the override is always light or dark, never unspecified, Auto included.
//!
//! That means WKWebView's `prefers-color-scheme` no longer tells the page
//! the iPhone's own appearance under Auto (it reports the override). So
//! native reads the system's style itself (the window scene's traits,
//! which the windows' overrides don't reach) and tells the page:
//! `window.__k2SystemAppearance("light" | "dark")`. It does so after every
//! `set_appearance`, when the app becomes active, on a scene trait change
//! (iOS 17+ `registerForTraitChanges`; iOS 15–16 catch up at the next
//! activation or input focus) and when an input takes focus. Native also
//! restyles itself at those moments, before the page answers.
//!
//! Launch order: the native window exists before any JS runs, and the
//! choice lives in the page's localStorage. So the command also saves the
//! mode, each side's page colour and each side's palette scheme in
//! NSUserDefaults, and the next launch starts from there: `install_early`
//! (run(), before the first window exists) stamps the saved look, resolved
//! against the system, on every window as it becomes visible, `apply`
//! (setup) on the web view and its window. Nothing saved (a fresh install)
//! is Dark on black: exactly the old lock. A save from a build before the
//! palette schemes takes each side's own scheme (dark side dark, light
//! side light). The page re-sends its choice at startup (initTheme), so a
//! lost or stale save corrects itself on the first frame of JS.

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
}

/// A palette's scheme (Obsidian and Dusk are dark, Veil light), or the
/// iPhone's own appearance.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scheme {
    Light,
    Dark,
}

impl Scheme {
    pub fn parse(s: &str) -> Option<Scheme> {
        match s {
            "light" => Some(Scheme::Light),
            "dark" => Some(Scheme::Dark),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Scheme::Light => "light",
            Scheme::Dark => "dark",
        }
    }

    /// UIUserInterfaceStyle: 1 light, 2 dark. (0, unspecified, is never
    /// set: see the module note.)
    pub fn ui_style(self) -> i64 {
        match self {
            Scheme::Light => 1,
            Scheme::Dark => 2,
        }
    }

    /// From a trait collection's UIUserInterfaceStyle: light is light,
    /// anything else (dark, unspecified) dark, as the old lock.
    pub fn from_ui_style(style: i64) -> Scheme {
        if style == 1 {
            Scheme::Light
        } else {
            Scheme::Dark
        }
    }
}

/// What native runs in the page to tell it the iPhone's own appearance
/// (src/theme/nativeAppearance.ts defines the function).
pub fn page_js(system: Scheme) -> String {
    format!(
        "window.__k2SystemAppearance&&window.__k2SystemAppearance(\"{}\");",
        system.as_str()
    )
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

/// The mode, and each side's page colour and palette scheme.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Appearance {
    pub mode: Mode,
    pub dark_bg: Rgb,
    pub light_bg: Rgb,
    /// The dark side's palette's scheme (Veil there makes it light).
    pub dark_scheme: Scheme,
    /// The light side's palette's scheme (Obsidian or Dusk make it dark).
    pub light_scheme: Scheme,
}

impl Default for Appearance {
    fn default() -> Self {
        Appearance {
            mode: Mode::Dark,
            dark_bg: DARK_BG_DEFAULT,
            light_bg: LIGHT_BG_DEFAULT,
            dark_scheme: Scheme::Dark,
            light_scheme: Scheme::Light,
        }
    }
}

/// `set_appearance`'s strings, or the saved ones.
#[derive(Clone, Copy, Debug, Default)]
pub struct Strs<'a> {
    pub mode: Option<&'a str>,
    pub dark_bg: Option<&'a str>,
    pub light_bg: Option<&'a str>,
    pub dark_scheme: Option<&'a str>,
    pub light_scheme: Option<&'a str>,
}

impl Appearance {
    /// Anything missing or unreadable keeps `base`'s value.
    pub fn from_strs(base: Appearance, s: Strs<'_>) -> Self {
        Appearance {
            mode: s.mode.and_then(Mode::parse).unwrap_or(base.mode),
            dark_bg: s.dark_bg.and_then(parse_hex).unwrap_or(base.dark_bg),
            light_bg: s.light_bg.and_then(parse_hex).unwrap_or(base.light_bg),
            dark_scheme: s.dark_scheme.and_then(Scheme::parse).unwrap_or(base.dark_scheme),
            light_scheme: s.light_scheme.and_then(Scheme::parse).unwrap_or(base.light_scheme),
        }
    }

    /// True when the light side's palette is on screen: Auto picks by the
    /// system.
    fn light_side(&self, system: Scheme) -> bool {
        match self.mode {
            Mode::Light => true,
            Mode::Dark => false,
            Mode::Auto => system == Scheme::Light,
        }
    }

    /// The page colour shown.
    pub fn bg(&self, system: Scheme) -> Rgb {
        if self.light_side(system) {
            self.light_bg
        } else {
            self.dark_bg
        }
    }

    /// The scheme of the palette shown, which the keyboard, the status bar
    /// and native sheets take.
    pub fn scheme(&self, system: Scheme) -> Scheme {
        if self.light_side(system) {
            self.light_scheme
        } else {
            self.dark_scheme
        }
    }

    /// The override for the windows and the web view: always light or dark.
    pub fn ui_style(&self, system: Scheme) -> i64 {
        self.scheme(system).ui_style()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strs<'a>(
        mode: Option<&'a str>,
        dark_bg: Option<&'a str>,
        light_bg: Option<&'a str>,
        dark_scheme: Option<&'a str>,
        light_scheme: Option<&'a str>,
    ) -> Strs<'a> {
        Strs { mode, dark_bg, light_bg, dark_scheme, light_scheme }
    }

    #[test]
    fn modes_and_schemes_parse_and_map_to_ui_styles() {
        assert_eq!(Mode::parse("light"), Some(Mode::Light));
        assert_eq!(Mode::parse("dark"), Some(Mode::Dark));
        assert_eq!(Mode::parse("auto"), Some(Mode::Auto));
        assert_eq!(Mode::parse("Dark"), None);
        for m in [Mode::Light, Mode::Dark, Mode::Auto] {
            assert_eq!(Mode::parse(m.as_str()), Some(m));
        }
        assert_eq!(Scheme::parse("light"), Some(Scheme::Light));
        assert_eq!(Scheme::parse("dark"), Some(Scheme::Dark));
        assert_eq!(Scheme::parse("auto"), None);
        assert_eq!(Scheme::Light.ui_style(), 1);
        assert_eq!(Scheme::Dark.ui_style(), 2);
        assert_eq!(Scheme::from_ui_style(1), Scheme::Light);
        assert_eq!(Scheme::from_ui_style(2), Scheme::Dark);
        assert_eq!(Scheme::from_ui_style(0), Scheme::Dark);
        for s in [Scheme::Light, Scheme::Dark] {
            assert_eq!(Scheme::parse(s.as_str()), Some(s));
            assert_eq!(Scheme::from_ui_style(s.ui_style()), s);
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
        let a = Appearance::from_strs(Appearance::default(), Strs::default());
        assert_eq!(a.mode, Mode::Dark);
        for system in [Scheme::Light, Scheme::Dark] {
            assert_eq!(a.bg(system), DARK_BG_DEFAULT);
            assert_eq!(a.ui_style(system), 2);
        }
    }

    #[test]
    fn bad_values_keep_the_base_and_auto_follows_the_system() {
        let a = Appearance::from_strs(
            Appearance::default(),
            strs(Some("auto"), Some("#100f0e"), Some("nope"), None, Some("bogus")),
        );
        assert_eq!(a.mode, Mode::Auto);
        assert_eq!(a.light_scheme, Scheme::Light);
        assert_eq!(to_hex(a.bg(Scheme::Dark)), "#100f0e");
        assert_eq!(a.bg(Scheme::Light), LIGHT_BG_DEFAULT);
        let b = Appearance::from_strs(a, strs(Some("bogus"), None, Some("#ffffff"), None, None));
        assert_eq!(b.mode, Mode::Auto);
        assert_eq!(to_hex(b.bg(Scheme::Light)), "#ffffff");
        let light = Appearance::from_strs(b, strs(Some("light"), None, None, None, None));
        assert_eq!(to_hex(light.bg(Scheme::Dark)), "#ffffff");
    }

    #[test]
    fn a_save_from_before_palette_schemes_keeps_each_sides_own_style() {
        // 4.2.x saved only the mode and colours: Light stays light, Dark
        // dark, Auto follows the iPhone, until the page re-sends.
        let base = Appearance::default();
        let light = Appearance::from_strs(base, strs(Some("light"), None, None, None, None));
        let dark = Appearance::from_strs(base, strs(Some("dark"), None, None, None, None));
        let auto = Appearance::from_strs(base, strs(Some("auto"), None, None, None, None));
        for system in [Scheme::Light, Scheme::Dark] {
            assert_eq!(light.ui_style(system), 1);
            assert_eq!(dark.ui_style(system), 2);
        }
        assert_eq!(auto.ui_style(Scheme::Light), 1);
        assert_eq!(auto.ui_style(Scheme::Dark), 2);
    }

    #[test]
    fn the_override_follows_the_palette_on_screen() {
        // (mode, dark side's scheme, light side's scheme, system) → style.
        let cases = [
            // Light: the light side's palette, whatever the iPhone shows.
            ("light", "dark", "light", Scheme::Light, 1), // Veil by day
            ("light", "dark", "light", Scheme::Dark, 1),
            ("light", "dark", "dark", Scheme::Light, 2), // Obsidian / Dusk by day
            ("light", "dark", "dark", Scheme::Dark, 2),
            // Dark: the dark side's palette.
            ("dark", "dark", "light", Scheme::Light, 2),
            ("dark", "light", "light", Scheme::Dark, 1), // Veil for the night side
            // Auto: the side the iPhone is in, that palette's scheme.
            ("auto", "dark", "dark", Scheme::Light, 2), // the default: Obsidian by day
            ("auto", "dark", "dark", Scheme::Dark, 2), // Dusk at night
            ("auto", "dark", "light", Scheme::Light, 1),
            ("auto", "dark", "light", Scheme::Dark, 2),
            ("auto", "light", "dark", Scheme::Light, 2),
            ("auto", "light", "dark", Scheme::Dark, 1),
        ];
        for (mode, dark, light, system, want) in cases {
            let a = Appearance::from_strs(
                Appearance::default(),
                strs(Some(mode), Some("#100f0e"), Some("#0a0a0a"), Some(dark), Some(light)),
            );
            assert_eq!(a.ui_style(system), want, "{mode} dark={dark} light={light} system={system:?}");
        }
    }

    #[test]
    fn the_page_colour_still_follows_the_side_shown() {
        let a = Appearance::from_strs(
            Appearance::default(),
            strs(Some("auto"), Some("#100f0e"), Some("#0a0a0a"), Some("dark"), Some("dark")),
        );
        assert_eq!(to_hex(a.bg(Scheme::Light)), "#0a0a0a");
        assert_eq!(to_hex(a.bg(Scheme::Dark)), "#100f0e");
    }

    #[test]
    fn the_page_is_told_the_system_appearance() {
        assert_eq!(
            page_js(Scheme::Light),
            "window.__k2SystemAppearance&&window.__k2SystemAppearance(\"light\");"
        );
        assert!(page_js(Scheme::Dark).ends_with("(\"dark\");"));
    }
}

#[cfg(target_os = "ios")]
pub mod ios {
    use super::{page_js, to_hex, Appearance, Rgb, Scheme, Strs};
    use objc2::runtime::{AnyClass, AnyObject, ClassBuilder, Sel};
    use objc2::{class, msg_send, sel};
    use std::ffi::{c_char, c_void, CStr, CString};
    use std::sync::atomic::{AtomicPtr, AtomicU8, Ordering};
    use std::sync::Mutex;

    const KEY_MODE: &CStr = c"k2.appearance.mode";
    const KEY_DARK_BG: &CStr = c"k2.appearance.darkBg";
    const KEY_LIGHT_BG: &CStr = c"k2.appearance.lightBg";
    const KEY_DARK_SCHEME: &CStr = c"k2.appearance.darkScheme";
    const KEY_LIGHT_SCHEME: &CStr = c"k2.appearance.lightScheme";
    const OBSERVER_CLASS_NAME: &CStr = c"K2AppearanceObserver";

    /// UIApplicationStateBackground.
    const APP_STATE_BACKGROUND: i64 = 2;

    static CURRENT: Mutex<Option<Appearance>> = Mutex::new(None);
    /// The web view `apply` last styled (for the observers).
    static WEBVIEW: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());
    /// The observer object (install_early), the target for scene traits.
    static OBSERVER: AtomicPtr<AnyObject> = AtomicPtr::new(std::ptr::null_mut());
    /// The window scene whose trait changes are watched.
    static WATCHED_SCENE: AtomicPtr<AnyObject> = AtomicPtr::new(std::ptr::null_mut());
    /// What the page was last told: 0 nothing, else a UIUserInterfaceStyle.
    static TOLD: AtomicU8 = AtomicU8::new(0);

    #[link(name = "UIKit", kind = "framework")]
    extern "C" {
        static UIWindowDidBecomeVisibleNotification: *const AnyObject;
        static UIApplicationDidBecomeActiveNotification: *const AnyObject;
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

    /// The look in force: what the page last sent, else what was saved,
    /// else Dark on black.
    pub fn current() -> Appearance {
        let mut slot = CURRENT.lock().unwrap_or_else(|e| e.into_inner());
        *slot.get_or_insert_with(|| {
            let (mode, dark_bg, light_bg) = (read(KEY_MODE), read(KEY_DARK_BG), read(KEY_LIGHT_BG));
            let (dark_scheme, light_scheme) = (read(KEY_DARK_SCHEME), read(KEY_LIGHT_SCHEME));
            Appearance::from_strs(
                Appearance::default(),
                Strs {
                    mode: mode.as_deref(),
                    dark_bg: dark_bg.as_deref(),
                    light_bg: light_bg.as_deref(),
                    dark_scheme: dark_scheme.as_deref(),
                    light_scheme: light_scheme.as_deref(),
                },
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
        write(KEY_DARK_SCHEME, a.dark_scheme.as_str());
        write(KEY_LIGHT_SCHEME, a.light_scheme.as_str());
    }

    unsafe fn ui_color((r, g, b): Rgb) -> *mut AnyObject {
        msg_send![class!(UIColor), colorWithRed: r, green: g, blue: b, alpha: 1.0f64]
    }

    /// The first connected window scene, if any.
    unsafe fn first_window_scene() -> *mut AnyObject {
        let app: *mut AnyObject = msg_send![class!(UIApplication), sharedApplication];
        if app.is_null() {
            return std::ptr::null_mut();
        }
        let scenes: *mut AnyObject = msg_send![app, connectedScenes];
        if scenes.is_null() {
            return std::ptr::null_mut();
        }
        let scenes: *mut AnyObject = msg_send![scenes, allObjects];
        if scenes.is_null() {
            return std::ptr::null_mut();
        }
        let n: usize = msg_send![scenes, count];
        for i in 0..n {
            let scene: *mut AnyObject = msg_send![scenes, objectAtIndex: i];
            if scene.is_null() {
                continue;
            }
            let is_window_scene: bool = msg_send![scene, isKindOfClass: class!(UIWindowScene)];
            if is_window_scene {
                return scene;
            }
        }
        std::ptr::null_mut()
    }

    unsafe fn style_of(env: *mut AnyObject) -> Option<i64> {
        if env.is_null() {
            return None;
        }
        let traits: *mut AnyObject = msg_send![env, traitCollection];
        if traits.is_null() {
            return None;
        }
        Some(msg_send![traits, userInterfaceStyle])
    }

    /// The iPhone's own appearance. The window scene's traits (the
    /// windows' and web view's overrides sit below it and don't reach it;
    /// there is no plist lock), else the screen's before any scene exists.
    pub fn system() -> Scheme {
        unsafe {
            let style = match style_of(first_window_scene()) {
                Some(s) => s,
                None => {
                    let screen: *mut AnyObject = msg_send![class!(UIScreen), mainScreen];
                    style_of(screen).unwrap_or(0)
                }
            };
            Scheme::from_ui_style(style)
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

    /// The style of the palette on screen on the web view, its window and
    /// every window of every scene (the keyboard, the status bar and
    /// native sheets follow), and the page colour behind the web view.
    /// `bg`: the colour the page shows now (sent with the look); None
    /// picks by the look and the system. Idempotent; main thread only.
    pub fn apply(webview_ptr: *mut c_void, bg: Option<Rgb>) {
        let a = current();
        let system = system();
        let style = a.ui_style(system);
        let bg = bg.unwrap_or_else(|| a.bg(system));
        unsafe {
            each_window(|w| set_style(w, style));
            let wk: *mut AnyObject = webview_ptr.cast();
            if wk.is_null() {
                return;
            }
            WEBVIEW.store(webview_ptr, Ordering::Release);
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
            let scene: *mut AnyObject = msg_send![window, windowScene];
            watch_scene(scene);
            // Status bar text: the root controller's default style follows
            // its traits; ask UIKit to look again.
            let root: *mut AnyObject = msg_send![window, rootViewController];
            if !root.is_null() {
                let _: () = msg_send![root, setNeedsStatusBarAppearanceUpdate];
            }
        }
    }

    /// Tell the page the iPhone's own appearance (src/theme/
    /// nativeAppearance.ts): when it changed since the last telling, or
    /// always with `force` (a `set_appearance`: the page may have
    /// reloaded). Main thread only.
    pub fn tell_page(force: bool) {
        let wk: *mut AnyObject = WEBVIEW.load(Ordering::Acquire).cast();
        if wk.is_null() {
            return;
        }
        let system = system();
        let code = system.ui_style() as u8;
        if TOLD.swap(code, Ordering::AcqRel) == code && !force {
            return;
        }
        let Ok(js) = CString::new(page_js(system)) else {
            return;
        };
        unsafe {
            let s = ns_str(&js);
            if s.is_null() {
                return;
            }
            let _: () = msg_send![wk, evaluateJavaScript: s, completionHandler: std::ptr::null::<AnyObject>()];
        }
    }

    /// Re-read the system: restyle natively (the keyboard is right at
    /// once) and tell the page if it changed. Main thread only.
    pub fn refresh(webview_ptr: *mut c_void) {
        apply(webview_ptr, None);
        tell_page(false);
    }

    /// The observers' path: skipped in the background (iOS flips a
    /// scene's traits there to snapshot both appearances; the next
    /// activation reads the real one).
    fn refresh_live() {
        unsafe {
            let app: *mut AnyObject = msg_send![class!(UIApplication), sharedApplication];
            if !app.is_null() {
                let state: i64 = msg_send![app, applicationState];
                if state == APP_STATE_BACKGROUND {
                    return;
                }
            }
        }
        let wk = WEBVIEW.load(Ordering::Acquire);
        if !wk.is_null() {
            refresh(wk);
        }
    }

    /// iOS 17+: hear the scene's light/dark change while the app is on
    /// screen (Control Center leaves the app active on some devices; the
    /// sunset switch can land mid-use). Earlier iOS has no trait
    /// observation for a scene; it catches up on activation or focus.
    unsafe fn watch_scene(scene: *mut AnyObject) {
        let observer = OBSERVER.load(Ordering::Acquire);
        if scene.is_null() || observer.is_null() || WATCHED_SCENE.load(Ordering::Acquire) == scene {
            return;
        }
        let can: bool = msg_send![scene, respondsToSelector: sel!(registerForTraitChanges:withTarget:action:)];
        if !can {
            return;
        }
        let Some(trait_class) = AnyClass::get(c"UITraitUserInterfaceStyle") else {
            return;
        };
        // The traits array holds the trait's class object.
        let trait_obj: *const AnyObject = (trait_class as *const AnyClass).cast();
        let traits: *mut AnyObject = msg_send![class!(NSArray), arrayWithObject: trait_obj];
        if traits.is_null() {
            return;
        }
        let _registration: *mut AnyObject = msg_send![
            scene,
            registerForTraitChanges: traits,
            withTarget: observer,
            action: sel!(k2SceneTraits:previous:)
        ];
        WATCHED_SCENE.store(scene, Ordering::Release);
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
                set_style(w, current().ui_style(system()));
            }
        }
    }

    extern "C-unwind" fn on_became_active(_this: &AnyObject, _cmd: Sel, _note: *mut AnyObject) {
        refresh_live();
    }

    extern "C-unwind" fn on_scene_traits(
        _this: &AnyObject,
        _cmd: Sel,
        _env: *mut AnyObject,
        _previous: *mut AnyObject,
    ) {
        refresh_live();
    }

    /// Before the first window: every window that becomes visible (the
    /// app's at launch, an iPad's second scene, UIKit's own) takes the
    /// saved look at once, so a dark user never sees the system's light
    /// for a frame before setup; and the system's appearance is re-read
    /// whenever the app becomes active. Call once, early in run().
    pub fn install_early() {
        let _ = current(); // load the saved look now, off the first frame
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
            builder.add_method(
                sel!(k2BecameActive:),
                on_became_active as extern "C-unwind" fn(_, _, _),
            );
            builder.add_method(
                sel!(k2SceneTraits:previous:),
                on_scene_traits as extern "C-unwind" fn(_, _, _, _),
            );
        }
        let cls = builder.register();
        unsafe {
            // Lives for the process: the center and the scene keep weak
            // references.
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
            let _: () = msg_send![center, addObserver: observer, selector: sel!(k2WindowVisible:), name: UIWindowDidBecomeVisibleNotification, object: none];
            let _: () = msg_send![center, addObserver: observer, selector: sel!(k2BecameActive:), name: UIApplicationDidBecomeActiveNotification, object: none];
        }
    }
}
