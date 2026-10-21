// Messages that arrived in sealed pushes, waiting for the app (K2 0.46.3
// `push-e2e-v1`: the sealed Thread alert's `msg`). ONE source shared by
// the k2-push plugin and the Notification Service Extension (project.yml).
//
// The NSE appends each opened message here (an App Group file, written
// under an NSFileCoordinator like K2BadgeStore). The app drains it on
// launch and foreground and merges the messages into its chat cache, so
// the Thread opens with them already there. At most MAX entries (oldest
// dropped); entries older than MAX_AGE are dropped on read. The file is
// protected until the first unlock, like the notification itself, and is
// wiped with the push keys on a fresh install.

import Foundation

public enum K2PushInbox {
  public static let max = 200
  static let maxAgeSecs: Double = 7 * 86_400
  private static let lock = NSLock()

  static func file() -> URL? {
    FileManager.default
      .containerURL(forSecurityApplicationGroupIdentifier: K2PushKeys.appGroup)?
      .appendingPathComponent("push-e2e", isDirectory: true)
      .appendingPathComponent("inbox.json")
  }

  /// One sealed `msg`, with the routing the app needs: the server's label
  /// and badge key (which saved account), and the Thread address.
  public static func entry(msg: [String: Any], userInfo: [String: Any], now: Date = Date()) -> [String: Any]? {
    guard let id = msg["id"] as? String, !id.isEmpty else { return nil }
    var e: [String: Any] = ["msg": msg, "receivedAt": now.timeIntervalSince1970]
    for k in ["subdomain", "badgeKey", "instanceId", "addr", "conversationId", "projectId", "agentName"] {
      if let v = userInfo[k] as? String, !v.isEmpty { e[k] = v }
    }
    return e
  }

  public static func append(_ e: [String: Any]) {
    guard let file = file() else { return }
    lock.lock()
    defer { lock.unlock() }
    try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    var coordError: NSError?
    NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: file, options: .forMerging, error: &coordError) { url in
      var rows = ((try? JSONSerialization.jsonObject(with: Data(contentsOf: url))) as? [[String: Any]]) ?? []
      rows.append(e)
      if rows.count > max { rows.removeFirst(rows.count - max) }
      if let data = try? JSONSerialization.data(withJSONObject: rows) {
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      }
    }
  }

  /// Everything waiting (fresh enough), and the file emptied.
  public static func drain(now: Date = Date()) -> [[String: Any]] {
    guard let file = file() else { return [] }
    lock.lock()
    defer { lock.unlock() }
    var out: [[String: Any]] = []
    var coordError: NSError?
    NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: file, options: .forMerging, error: &coordError) { url in
      let rows = ((try? JSONSerialization.jsonObject(with: Data(contentsOf: url))) as? [[String: Any]]) ?? []
      let cutoff = now.timeIntervalSince1970 - maxAgeSecs
      out = rows.filter { (($0["receivedAt"] as? NSNumber)?.doubleValue ?? 0) >= cutoff }
      try? FileManager.default.removeItem(at: url)
    }
    return out
  }

  public static func clear() {
    guard let file = file() else { return }
    lock.lock()
    defer { lock.unlock() }
    try? FileManager.default.removeItem(at: file)
  }
}
