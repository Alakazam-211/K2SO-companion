// Replay check for sealed pushes (K2 0.46.3 `push-e2e-v1`, prd §3). ONE
// source shared by the k2-push plugin and the Notification Service
// Extension (project.yml).
//
// Per key id, the last WINDOW accepted `ctr` values. A push is fresh when
// its `ctr` is not among them, the set is not full or `ctr` is above the
// set's lowest, and `ts` is within the last 30 days and at most a day
// ahead. The box sets `ctr = max(next, unix_ms)`, so a restored backup on
// the box never rewinds it. Not fresh: iOS shows the generic text (an NSE
// must deliver something), the app ignores a nudge.
//
// The set is a small JSON file in the App Group, read and written under
// an NSFileCoordinator (the app and the NSE may run at once), as
// K2BadgeStore does.

import Foundation

public enum K2PushReplay {
  public static let window = 256
  static let maxAgeSecs: Double = 30 * 86_400
  static let maxAheadSecs: Double = 86_400
  private static let lock = NSLock()

  static func file() -> URL? {
    FileManager.default
      .containerURL(forSecurityApplicationGroupIdentifier: K2PushKeys.appGroup)?
      .appendingPathComponent("push-e2e", isDirectory: true)
      .appendingPathComponent("seen.json")
  }

  /// Pure rule (tests): is (`ctr`, `ts`) fresh against `seen`?
  public static func isFresh(ctr: UInt64, ts: Double, seen: [UInt64], now: Double) -> Bool {
    guard ts >= now - maxAgeSecs, ts <= now + maxAheadSecs else { return false }
    if seen.contains(ctr) { return false }
    if seen.count >= window, let low = seen.min(), ctr <= low { return false }
    return true
  }

  /// Check and record in one step. True = fresh (and now recorded).
  public static func accept(keyId: String, ctr: UInt64, ts: Double, now: Double = Date().timeIntervalSince1970) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard let file = file() else { return isFresh(ctr: ctr, ts: ts, seen: [], now: now) }
    var fresh = false
    try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    var coordError: NSError?
    let body: (URL) -> Void = { url in
      var all = (try? JSONDecoder().decode([String: [UInt64]].self, from: Data(contentsOf: url))) ?? [:]
      var seen = all[keyId] ?? []
      fresh = isFresh(ctr: ctr, ts: ts, seen: seen, now: now)
      guard fresh else { return }
      seen.append(ctr)
      seen.sort()
      if seen.count > window { seen.removeFirst(seen.count - window) }
      all[keyId] = seen
      if let data = try? JSONEncoder().encode(all) {
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      }
    }
    var ran = false
    NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: file, options: .forMerging, error: &coordError) { url in
      ran = true
      body(url)
    }
    if !ran { body(file) }
    return fresh
  }

  /// A key went away: its seen-set too.
  public static func forget(keyIds: [String]) {
    guard !keyIds.isEmpty, let file = file() else { return }
    lock.lock()
    defer { lock.unlock() }
    var coordError: NSError?
    NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: file, options: .forMerging, error: &coordError) { url in
      guard var all = try? JSONDecoder().decode([String: [UInt64]].self, from: Data(contentsOf: url)) else { return }
      for k in keyIds { all.removeValue(forKey: k) }
      if let data = try? JSONEncoder().encode(all) {
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      }
    }
  }
}
