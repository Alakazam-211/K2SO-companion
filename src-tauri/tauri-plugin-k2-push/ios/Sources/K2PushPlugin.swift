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
//
// Avatars: `cacheAvatars` writes each workspace's icon as a 128px PNG
// into the App Group container (`K2AvatarStore` below). The Notification
// Service Extension (gen/apple/K2NotificationService) reads it to show
// the agent's picture on a Thread push (Communication Notifications).
// Without the App Group entitlement the container is nil and the command
// answers `available: false` — dormant, like the rest of this file.

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

  /// Store workspace avatars for the Notification Service Extension.
  /// Args `{items: [{key, rev, dataUrl}]}`. Decoding/scaling runs off
  /// the main thread on a serial queue. Never rejects for bad items
  /// (they count as `failed`); rejects only for unparseable args.
  @objc public func cacheAvatars(_ invoke: Invoke) {
    let args: CacheAvatarsArgs
    do {
      args = try invoke.parseArgs(CacheAvatarsArgs.self)
    } catch {
      invoke.reject("cacheAvatars: invalid args (\(error.localizedDescription))")
      return
    }
    K2AvatarStore.queue.async {
      let outcome = K2AvatarStore.store(args.items)
      var res: JsonObject = [
        "available": outcome.available,
        "written": outcome.written,
        "skipped": outcome.skipped,
        "failed": outcome.failed,
      ]
      if let reason = outcome.reason { res["reason"] = reason }
      invoke.resolve(res)
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

// ── Notification avatar cache (App Group) ─────────────────────────────

private struct CacheAvatarsArgs: Decodable {
  let items: [AvatarItemArg]
}

private struct AvatarItemArg: Decodable {
  let key: String
  let rev: String
  let dataUrl: String
}

/// Layout shared with the Notification Service Extension (keep in sync
/// with gen/apple/K2NotificationService/NotificationService.swift):
///   <AppGroup>/avatars/index.json
///     {"version":1,"entries":{"<subdomain>|<projectid>":{"rev","file","at"}}}
///   <AppGroup>/avatars/<file>.png   — 128x128 PNG, aspect-fill, square
/// Keys are lowercased. `at` = last time the app saw the entry (seconds
/// since 1970); the oldest entries are dropped past `maxEntries`.
enum K2AvatarStore {
  static let appGroupId = "group.com.alakazamlabs.k2so.companion"
  static let maxEntries = 300
  static let side: CGFloat = 128
  static let queue = DispatchQueue(label: "com.alakazamlabs.k2so.companion.avatars", qos: .utility)

  struct Entry: Codable {
    var rev: String
    var file: String
    var at: Double
  }

  struct Index: Codable {
    var version: Int
    var entries: [String: Entry]
  }

  struct Outcome {
    var available = true
    var written = 0
    var skipped = 0
    var failed = 0
    var reason: String?
  }

  static func directory() -> URL? {
    guard
      let container = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: appGroupId)
    else { return nil }
    return container.appendingPathComponent("avatars", isDirectory: true)
  }

  /// Serial-queue only.
  fileprivate static func store(_ items: [AvatarItemArg]) -> Outcome {
    var out = Outcome()
    guard let dir = directory() else {
      out.available = false
      out.reason = "no App Group container (\(appGroupId) entitlement missing)"
      return out
    }
    let fm = FileManager.default
    do {
      try fm.createDirectory(at: dir, withIntermediateDirectories: true)
    } catch {
      out.available = false
      out.reason = "avatars directory: \(error.localizedDescription)"
      return out
    }
    var index = loadIndex(dir) ?? Index(version: 1, entries: [:])
    let now = Date().timeIntervalSince1970
    for item in items {
      let key = item.key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      let rev = item.rev.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !key.isEmpty, !rev.isEmpty else {
        out.failed += 1
        continue
      }
      if var entry = index.entries[key], entry.rev == rev,
        fm.fileExists(atPath: dir.appendingPathComponent(entry.file).path)
      {
        entry.at = now
        index.entries[key] = entry
        out.skipped += 1
        continue
      }
      guard let data = decodeDataUrl(item.dataUrl),
        let image = UIImage(data: data),
        let png = squarePNG(image)
      else {
        out.failed += 1
        continue
      }
      let file = fileName(for: key)
      do {
        try png.write(
          to: dir.appendingPathComponent(file),
          options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      } catch {
        out.failed += 1
        continue
      }
      index.entries[key] = Entry(rev: rev, file: file, at: now)
      out.written += 1
    }
    prune(&index, dir: dir)
    if let json = try? JSONEncoder().encode(index) {
      try? json.write(
        to: dir.appendingPathComponent("index.json"),
        options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    return out
  }

  private static func loadIndex(_ dir: URL) -> Index? {
    guard let data = try? Data(contentsOf: dir.appendingPathComponent("index.json")) else {
      return nil
    }
    return try? JSONDecoder().decode(Index.self, from: data)
  }

  /// Drop the least-recently-seen entries (and their files) past the cap.
  private static func prune(_ index: inout Index, dir: URL) {
    let extra = index.entries.count - maxEntries
    guard extra > 0 else { return }
    let oldest = index.entries.sorted { $0.value.at < $1.value.at }.prefix(extra)
    for (key, entry) in oldest {
      index.entries[key] = nil
      // Another key never shares a file name (the name embeds a hash of
      // the key), so deleting is safe.
      try? FileManager.default.removeItem(at: dir.appendingPathComponent(entry.file))
    }
  }

  /// `data:image/<type>[;base64],<payload>` → bytes. SVG is refused
  /// (UIImage cannot decode it).
  static func decodeDataUrl(_ url: String) -> Data? {
    let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.lowercased().hasPrefix("data:image/"),
      let comma = trimmed.firstIndex(of: ",")
    else { return nil }
    let header = trimmed[..<comma].lowercased()
    if header.contains("svg") { return nil }
    let payload = String(trimmed[trimmed.index(after: comma)...])
    if header.hasSuffix(";base64") {
      return Data(base64Encoded: payload, options: .ignoreUnknownCharacters)
    }
    return payload.removingPercentEncoding?.data(using: .utf8)
  }

  /// Aspect-fill into a `side`x`side` square at scale 1 (128 px).
  static func squarePNG(_ image: UIImage) -> Data? {
    let size = image.size
    guard size.width > 0, size.height > 0 else { return nil }
    let format = UIGraphicsImageRendererFormat.default()
    format.scale = 1
    format.opaque = false
    let renderer = UIGraphicsImageRenderer(
      size: CGSize(width: side, height: side), format: format)
    let scale = max(side / size.width, side / size.height)
    let w = size.width * scale
    let h = size.height * scale
    return renderer.pngData { _ in
      image.draw(in: CGRect(x: (side - w) / 2, y: (side - h) / 2, width: w, height: h))
    }
  }

  /// Filesystem-safe, collision-free name: a readable prefix of the key
  /// plus a 64-bit FNV-1a hash of the whole key.
  static func fileName(for key: String) -> String {
    var hash: UInt64 = 0xcbf2_9ce4_8422_2325
    for byte in key.utf8 {
      hash ^= UInt64(byte)
      hash = hash &* 0x0000_0100_0000_01b3
    }
    let allowed = Set("abcdefghijklmnopqrstuvwxyz0123456789-_.")
    let readable = String(key.map { allowed.contains($0) ? $0 : "_" }.prefix(60))
    return "\(readable)-\(String(format: "%016llx", hash)).png"
  }
}

@_cdecl("init_plugin_k2_push")
func initPlugin() -> Plugin {
  return K2PushPlugin()
}
