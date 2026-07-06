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
// remote-notification callbacks, so `load` splices them onto the live
// delegate class at runtime (class_addMethod; if a future tao version
// adds its own implementations we wrap and call the originals).
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
  private var hooksInstalled = false
  private let tapDelegate = K2PushTapDelegate()

  override init() {
    super.init()
    K2PushPlugin.shared = self
  }

  @objc public override func load(webview: WKWebView) {
    tapDelegate.plugin = self
    DispatchQueue.main.async {
      self.installDelegateHooks()
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
    requestToken(timeoutSecs: 5) { result in
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
      if !self.hooksInstalled {
        // Delegate hooks couldn't be installed — a token could never be
        // observed; answer instead of hanging into the timeout.
        completion(.failure("APNs delegate hooks unavailable"))
        return
      }
      var settled = false
      let settle: (TokenResult) -> Void = { result in
        if settled { return }
        settled = true
        completion(result)
      }
      self.waiters.append(settle)
      UIApplication.shared.registerForRemoteNotifications()
      DispatchQueue.main.asyncAfter(deadline: .now() + timeoutSecs) {
        settle(.failure("timed out waiting for APNs registration"))
      }
    }
  }

  fileprivate func handleDeviceToken(_ deviceToken: Data) {
    let token = deviceToken.map { String(format: "%02x", $0) }.joined()
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

  /// Add (or wrap) the two remote-notification callbacks on the live
  /// UIApplicationDelegate class. Behavior-neutral until something
  /// calls `registerForRemoteNotifications` — i.e. fully dormant.
  private func installDelegateHooks() {
    guard let delegate = UIApplication.shared.delegate else { return }
    let cls: AnyClass = type(of: delegate)

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
    K2PushPlugin.originalSuccessImp = spliceMethod(
      cls, successSel, imp_implementationWithBlock(successBlock), types: "v@:@@")

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
    K2PushPlugin.originalFailureImp = spliceMethod(
      cls, failureSel, imp_implementationWithBlock(failureBlock), types: "v@:@@")

    hooksInstalled = true
  }

  private static var originalSuccessImp: IMP?
  private static var originalFailureImp: IMP?

  /// class_addMethod when the delegate doesn't implement the selector
  /// (tao today); otherwise swap in our IMP and return the original so
  /// the hook can chain to it.
  private func spliceMethod(_ cls: AnyClass, _ selector: Selector, _ imp: IMP, types: String)
    -> IMP?
  {
    if class_addMethod(cls, selector, imp, types) {
      return nil
    }
    guard let method = class_getInstanceMethod(cls, selector) else { return nil }
    return method_setImplementation(method, imp)
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
