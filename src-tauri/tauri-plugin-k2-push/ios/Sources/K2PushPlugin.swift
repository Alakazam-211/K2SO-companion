// K2 Companion push plugin — iOS half (Companion C6; feedback PRD §8.1).
//
// DORMANT-FIRST: this file must behave in a build with NO Push
// Notifications capability / `aps-environment` entitlement (today's
// shipped state). The load path only installs hooks — it never talks to
// APNs and never prompts. The availability probe uses
// `registerForRemoteNotifications`, which is prompt-free by design;
// without the entitlement it fails fast ("no valid 'aps-environment'
// entitlement string found", code 3000) and we surface that as
// `available: false` — never a crash, never a rejection.
//
// Token capture: tao's UIApplicationDelegate does not implement the
// remote-notification callbacks, so we splice them onto the live
// delegate class at runtime (class_addMethod; if a future tao version
// adds its own implementations we wrap and call the originals). Three
// traps this must survive (all bit us on-device):
//   1. UIApplication caches the delegate's respondsToSelector answers
//      in a flags bitfield when setDelegate: runs — tao sets the
//      delegate at app start, before the plugin loads, so methods
//      added later are never called until the delegate is RE-assigned.
//   2. The live delegate's runtime class may differ from what an early
//      hook saw (late-set or KVO-wrapped delegate), so hooks install
//      lazily at probe time against object_getClass(delegate) and are
//      re-verified before every registration.
//   3. registerForRemoteNotifications and the delegate mutation are
//      main-thread work; everything below is confined to main.
//
// Taps: we become the UNUserNotificationCenter delegate. A tap while
// running triggers the `tap` event; every tap is ALSO buffered so a
// cold-start tap (delegate set after the system delivered the response)
// can be drained by JS via `getLaunchTap`.

import SwiftRs
import Tauri
import UIKit
import UserNotifications
import WebKit
import ObjectiveC.runtime
import os.log

/// Console breadcrumb. Grep the device stream for "K2Push".
private func pushLog(_ message: String) {
  os_log("[K2Push] %{public}@", log: OSLog(subsystem: "com.alakazamlabs.k2so.companion", category: "k2push"), type: .default, message)
}

/// Registration outcome: an APNs token hex string, or a human-readable
/// failure reason (Result<String, String> needs Failure: Error).
private enum TokenResult {
  case success(String)
  case failure(String)
}

class K2PushPlugin: Plugin {
  // The delegate-hook C blocks need a way back into the instance; the
  // PluginManager keeps the plugin alive for the app's lifetime.
  static var shared: K2PushPlugin?

  private var apnsToken: String?
  private var waiters: [(TokenResult) -> Void] = []
  private var launchTap: [String: Any]?
  /// The runtime class the callbacks are currently spliced onto, plus a
  /// short human description ("AppDelegate add+add") for reason strings.
  private var hookedClass: AnyClass?
  private var hookDescription = "not installed"
  private let tapDelegate = K2PushTapDelegate()

  override init() {
    super.init()
    K2PushPlugin.shared = self
  }

  @objc public override func load(webview: WKWebView) {
    tapDelegate.plugin = self
    DispatchQueue.main.async {
      // Best-effort early install; ensureDelegateHooks re-verifies (and
      // re-installs against the live delegate class) before every probe.
      _ = self.ensureDelegateHooks()
      UNUserNotificationCenter.current().delegate = self.tapDelegate
    }
  }

  // ── Commands ────────────────────────────────────────────────────────

  /// Availability = "can this build obtain an APNs token". The probe
  /// registers for remote notifications (prompt-free) and waits for the
  /// delegate callback: token → available, error (missing entitlement,
  /// no network to APNs) → unavailable with the reason. Timeout answers
  /// unavailable without caching, so a later probe may recover.
  @objc public func isAvailable(_ invoke: Invoke) {
    // 10s: cold APNs handshakes on some networks exceed 5s.
    requestToken(timeoutSecs: 10) { result in
      switch result {
      case .success:
        invoke.resolve(["available": true, "platform": "ios"])
      case .failure(let reason):
        invoke.resolve(["available": false, "platform": "ios", "reason": reason])
      }
    }
  }

  /// The ONLY call that can show a system prompt. JS gates it behind
  /// `is_available()` + the user's Settings toggle.
  @objc public func requestPermission(_ invoke: Invoke) {
    UNUserNotificationCenter.current().requestAuthorization(options: [
      .alert, .badge, .sound,
    ]) { granted, error in
      if let error = error {
        invoke.reject(error.localizedDescription)
      } else {
        invoke.resolve(["granted": granted])
      }
    }
  }

  @objc public func getToken(_ invoke: Invoke) {
    requestToken(timeoutSecs: 10) { result in
      switch result {
      case .success(let token):
        invoke.resolve(["token": token, "platform": "apns"])
      case .failure(let reason):
        invoke.reject(reason)
      }
    }
  }

  /// Drain the buffered (cold-start) tap payload.
  @objc public func getLaunchTap(_ invoke: Invoke) {
    DispatchQueue.main.async {
      let tap = self.launchTap
      self.launchTap = nil
      if let tap = tap {
        invoke.resolve(["tap": tap])
      } else {
        invoke.resolve(["tap": NSNull()])
      }
    }
  }

  // ── Token plumbing ──────────────────────────────────────────────────

  /// All registration state is confined to the main queue (plugin
  /// commands arrive on the ipc queue; UIKit registration wants main).
  private func requestToken(timeoutSecs: Double, completion: @escaping (TokenResult) -> Void) {
    DispatchQueue.main.async {
      if let token = self.apnsToken {
        completion(.success(token))
        return
      }
      if !self.ensureDelegateHooks() {
        // Delegate hooks couldn't be installed — a token could never be
        // observed; answer instead of hanging into the timeout.
        completion(.failure("APNs delegate hooks unavailable (\(self.hookDescription))"))
        return
      }
      var settled = false
      let settle: (TokenResult) -> Void = { result in
        if settled { return }
        settled = true
        completion(result)
      }
      self.waiters.append(settle)
      pushLog("registerForRemoteNotifications (\(self.hookDescription))")
      UIApplication.shared.registerForRemoteNotifications()
      DispatchQueue.main.asyncAfter(deadline: .now() + timeoutSecs) {
        if !settled {
          pushLog("probe timed out after \(timeoutSecs)s (\(self.hookDescription))")
        }
        settle(.failure("timed out waiting for APNs registration (\(self.hookDescription))"))
      }
    }
  }

  fileprivate func handleDeviceToken(_ deviceToken: Data) {
    let token = deviceToken.map { String(format: "%02x", $0) }.joined()
    pushLog("callback received, token length \(deviceToken.count)")
    DispatchQueue.main.async {
      let rotated = self.apnsToken != nil && self.apnsToken != token
      self.apnsToken = token
      let pending = self.waiters
      self.waiters = []
      pending.forEach { $0(.success(token)) }
      if rotated {
        // Mid-session rotation — tell JS to re-run register-device.
        try? self.trigger("tokenRefresh", data: TokenRefreshEvent(token: token, platform: "apns"))
      }
    }
  }

  fileprivate func handleRegistrationError(_ error: Error) {
    pushLog("registration failed: \(error.localizedDescription)")
    DispatchQueue.main.async {
      let pending = self.waiters
      self.waiters = []
      pending.forEach { $0(.failure(error.localizedDescription)) }
    }
  }

  // ── Tap plumbing ────────────────────────────────────────────────────

  /// Push payload custom keys ride at the top level of `userInfo`
  /// (relay `apns.rs` convention): {kind, feedbackId?|groupId?,
  /// subdomain?}. Content-free by contract.
  fileprivate func handleTap(_ userInfo: [AnyHashable: Any]) {
    var data: [String: Any] = [:]
    for (key, value) in userInfo {
      guard let key = key as? String, key != "aps" else { continue }
      if let value = value as? String {
        data[key] = value
      }
    }
    DispatchQueue.main.async {
      self.launchTap = data
      if let jsData = JSTypes.coerceDictionaryToJSObject(data) {
        self.trigger("tap", data: jsData)
      }
    }
  }

  // ── AppDelegate splicing ────────────────────────────────────────────

  /// Splice the two remote-notification callbacks onto the RUNTIME
  /// class of the live UIApplicationDelegate, then re-assign the
  /// delegate so UIApplication rebuilds its cached respondsToSelector
  /// flags (built at setDelegate: time — tao sets the delegate before
  /// the plugin loads, so without the re-assign our late-added methods
  /// are never called). Called before every registration: if the live
  /// delegate's class no longer matches what we hooked (late-set or
  /// KVO-wrapped delegate), we re-install. Behavior-neutral until
  /// something calls `registerForRemoteNotifications` — i.e. dormant.
  /// Main thread only. Returns whether hooks are in place.
  private func ensureDelegateHooks() -> Bool {
    guard let delegate = UIApplication.shared.delegate else {
      hookDescription = "no app delegate"
      pushLog("hook skipped: no app delegate yet")
      return false
    }
    // object_getClass = the true runtime class (sees KVO wrappers that
    // type(of:)/`class` would hide); that is the class UIKit dispatches to.
    guard let cls = object_getClass(delegate) else {
      hookDescription = "delegate has no runtime class"
      pushLog("hook skipped: object_getClass returned nil")
      return false
    }
    if hookedClass === cls {
      return true
    }

    let successSel = #selector(
      UIApplicationDelegate.application(_:didRegisterForRemoteNotificationsWithDeviceToken:))
    let successBlock: @convention(block) (AnyObject, UIApplication, NSData) -> Void = {
      _self, application, token in
      K2PushPlugin.shared?.handleDeviceToken(token as Data)
      if let original = K2PushPlugin.originalSuccessImp {
        typealias Fn = @convention(c) (AnyObject, Selector, UIApplication, NSData) -> Void
        unsafeBitCast(original, to: Fn.self)(_self, successSel, application, token)
      }
    }
    let successMode = spliceMethod(
      cls, successSel, imp_implementationWithBlock(successBlock), types: "v@:@@",
      original: &K2PushPlugin.originalSuccessImp)

    let failureSel = #selector(
      UIApplicationDelegate.application(_:didFailToRegisterForRemoteNotificationsWithError:))
    let failureBlock: @convention(block) (AnyObject, UIApplication, NSError) -> Void = {
      _self, application, error in
      K2PushPlugin.shared?.handleRegistrationError(error)
      if let original = K2PushPlugin.originalFailureImp {
        typealias Fn = @convention(c) (AnyObject, Selector, UIApplication, NSError) -> Void
        unsafeBitCast(original, to: Fn.self)(_self, failureSel, application, error)
      }
    }
    let failureMode = spliceMethod(
      cls, failureSel, imp_implementationWithBlock(failureBlock), types: "v@:@@",
      original: &K2PushPlugin.originalFailureImp)

    // Bust UIApplication's cached delegate-flags bitfield: setDelegate:
    // re-scans which selectors the delegate answers — now including the
    // ones we just spliced in. Nil-then-restore because a same-pointer
    // assignment may short-circuit; safe because we're synchronous on
    // the main thread (no runloop dispatch can observe the nil).
    // CRITICAL: UIApplication *owns* the UIApplicationMain-created
    // delegate and releases it inside setDelegate:, while `.delegate`
    // itself is assign — without a replacement strong reference the
    // restore leaves a dangling pointer (crashed on-device as
    // "-[__NSSingleObjectArrayI applicationDidBecomeActive:]").
    K2PushPlugin.retainedDelegate = delegate
    UIApplication.shared.delegate = nil
    UIApplication.shared.delegate = delegate

    hookedClass = cls
    hookDescription =
      "hook on \(NSStringFromClass(cls)), installed=\(successMode)+\(failureMode), "
      + "responds=\(delegate.responds(to: successSel))"
    pushLog("hooks installed: \(hookDescription)")
    return true
  }

  private static var originalSuccessImp: IMP?
  private static var originalFailureImp: IMP?
  /// Keeps the (re-assigned) app delegate alive: UIApplication released
  /// its ownership during our setDelegate: dance and never re-retains.
  private static var retainedDelegate: UIApplicationDelegate?
  /// Every IMP we ever installed — a re-install must never "chain" to a
  /// stale hook of our own (infinite recursion through the statics).
  private static var installedImps: [IMP] = []

  /// class_addMethod when the class doesn't implement the selector (tao
  /// today); otherwise replace the implementation, storing the original
  /// IMP so the hook can chain to it. Returns the path taken ("add" /
  /// "replace") for breadcrumbs.
  private func spliceMethod(
    _ cls: AnyClass, _ selector: Selector, _ imp: IMP, types: String, original: inout IMP?
  ) -> String {
    K2PushPlugin.installedImps.append(imp)
    if class_addMethod(cls, selector, imp, types) {
      original = nil
      return "add"
    }
    guard let method = class_getInstanceMethod(cls, selector) else {
      original = nil
      return "add-failed"
    }
    let previous = method_setImplementation(method, imp)
    original = K2PushPlugin.installedImps.contains(previous) ? nil : previous
    return "replace"
  }
}

private struct TokenRefreshEvent: Encodable {
  let token: String
  let platform: String
}

/// UNUserNotificationCenter delegate: foreground presentation + tap
/// forwarding. Held strongly by the plugin (the center keeps a weak
/// reference).
private class K2PushTapDelegate: NSObject, UNUserNotificationCenterDelegate {
  weak var plugin: K2PushPlugin?

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler:
      @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    if #available(iOS 14.0, *) {
      completionHandler([.banner, .sound, .badge])
    } else {
      completionHandler([.alert, .sound, .badge])
    }
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    plugin?.handleTap(response.notification.request.content.userInfo)
    completionHandler()
  }
}

@_cdecl("init_plugin_k2_push")
func initPlugin() -> Plugin {
  return K2PushPlugin()
}
