// K2 Notification Service Extension — iOS Communication Notifications.
//
// A Thread push from the K2 relay carries `"mutable-content": 1`, so iOS
// runs this extension before showing it. We turn it into a
// communication notification: the agent's avatar is the large image and
// the K2 app icon becomes the small badge.
//
// Payload (custom keys at the top level of userInfo, all strings):
//   subdomain, projectId, addr, conversationId, avatarRev, agentColor
//   aps.alert.title = agent display name, aps.alert.body = text
//
// Avatar: read from the App Group cache the app fills
// (K2PushPlugin.swift `K2AvatarStore` — keep the layout in sync):
//   <AppGroup>/avatars/index.json
//     {"version":1,"entries":{"<subdomain>|<projectid>":{"rev","file","at"}}}
//   <AppGroup>/avatars/<file>.png
// There is one picture per key. If its `rev` differs from the push's
// `avatarRev`, we use it anyway: a stale picture beats initials. On a
// miss we draw the first letter of the title on `agentColor`.
//
// Badge (K2 0.46.1): Thread and project-chat pushes carry the
// recipient's totals on that server: `unreadTotal`, `waitingTotal`
// (strings holding integers) plus `subdomain` and, from K2 0.46.1,
// `badgeKey` (per person per server). We store them in the App Group badge
// store under `badgeKey`, else `subdomain` (K2BadgeStore.swift — the SAME
// source file as the app's k2-push plugin, added to this target by
// project.yml) and set the
// delivered content's `badge` to the sum across servers. No totals = the
// badge is left alone. Servers never send `aps.badge`.
//
// Rules: no network. Any error or a missing title/addr delivers the
// original content unchanged (apart from the badge). Without
// mutable-content (today's relay) this extension never runs.

import Intents
import UIKit
import UserNotifications

private let appGroupId = "group.com.alakazamlabs.k2so.companion"
private let avatarSide: CGFloat = 128

final class NotificationService: UNNotificationServiceExtension {
  private let lock = NSLock()
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var original: UNNotificationContent?
  private var bestAttempt: UNNotificationContent?
  private var delivered = false

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    // Badge first, so even the fallback paths carry it.
    let badge = Self.applyBadgeTotals(request.content.userInfo)
    let base = Self.withBadge(request.content, badge)

    lock.lock()
    self.contentHandler = contentHandler
    self.original = base
    lock.unlock()

    guard let built = Self.communicationIntent(for: request.content) else {
      deliver(base)
      return
    }
    let updated: UNNotificationContent
    do {
      updated = Self.withBadge(try request.content.updating(from: built), badge)
    } catch {
      deliver(base)
      return
    }
    lock.lock()
    bestAttempt = updated
    lock.unlock()

    let interaction = INInteraction(intent: built, response: nil)
    interaction.direction = .incoming
    interaction.donate { [weak self] _ in
      // A failed donation still leaves a valid updated content.
      self?.deliver(updated)
    }
  }

  override func serviceExtensionTimeWillExpire() {
    lock.lock()
    let content = bestAttempt ?? original
    lock.unlock()
    if let content = content { deliver(content) }
  }

  /// Calls the content handler exactly once.
  private func deliver(_ content: UNNotificationContent) {
    lock.lock()
    guard !delivered, let handler = contentHandler else {
      lock.unlock()
      return
    }
    delivered = true
    lock.unlock()
    handler(content)
  }

  // ── Badge (App Group, K2BadgeStore) ─────────────────────────────────

  /// Store this push's totals and count it as an alert delivery. Returns
  /// the new badge sum, or nil when the push has no numeric
  /// `unreadTotal` + a `badgeKey` or `subdomain` (or there is no App Group).
  static func applyBadgeTotals(_ info: [AnyHashable: Any]) -> Int? {
    K2BadgeStore.apply(push: info, source: .alert)?.sum
  }

  /// `content` with `badge` set; unchanged when `badge` is nil.
  static func withBadge(_ content: UNNotificationContent, _ badge: Int?) -> UNNotificationContent {
    guard let badge = badge,
      let mutable = content.mutableCopy() as? UNMutableNotificationContent
    else { return content }
    mutable.badge = NSNumber(value: badge)
    return mutable
  }

  // ── Intent ──────────────────────────────────────────────────────────

  /// nil = leave the notification as it is.
  static func communicationIntent(for content: UNNotificationContent) -> INSendMessageIntent? {
    let info = content.userInfo
    let title = content.title.trimmingCharacters(in: .whitespacesAndNewlines)
    let addr = string(info, "addr")
    guard !title.isEmpty, !addr.isEmpty else { return nil }

    let conversationId = string(info, "conversationId")
    let conversation = "thread:" + (conversationId.isEmpty ? addr : conversationId)

    let imageData =
      cachedAvatar(subdomain: string(info, "subdomain"), projectId: string(info, "projectId"))
      ?? initialsAvatar(title: title, colorHex: string(info, "agentColor"))
    let image = imageData.map { INImage(imageData: $0) }

    let person = INPerson(
      personHandle: INPersonHandle(value: addr, type: .unknown),
      nameComponents: nil,
      displayName: title,
      image: image,
      contactIdentifier: nil,
      customIdentifier: addr)

    let intent = INSendMessageIntent(
      recipients: nil,
      outgoingMessageType: .outgoingMessageText,
      content: content.body,
      speakableGroupName: nil,
      conversationIdentifier: conversation,
      serviceName: nil,
      sender: person,
      attachments: nil)
    if let image = image {
      intent.setImage(image, forParameterNamed: \.sender)
    }
    return intent
  }

  private static func string(_ info: [AnyHashable: Any], _ key: String) -> String {
    if let s = info[key] as? String { return s.trimmingCharacters(in: .whitespacesAndNewlines) }
    if let n = info[key] as? NSNumber { return n.stringValue }
    return ""
  }

  // ── Avatar cache (App Group) ────────────────────────────────────────

  private struct Entry: Decodable {
    let rev: String
    let file: String
  }

  private struct Index: Decodable {
    let entries: [String: Entry]
  }

  static func cachedAvatar(subdomain: String, projectId: String) -> Data? {
    guard !subdomain.isEmpty, !projectId.isEmpty,
      let container = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: appGroupId)
    else { return nil }
    let dir = container.appendingPathComponent("avatars", isDirectory: true)
    guard let raw = try? Data(contentsOf: dir.appendingPathComponent("index.json")),
      let index = try? JSONDecoder().decode(Index.self, from: raw)
    else { return nil }
    let key = "\(subdomain)|\(projectId)".lowercased()
    guard let entry = index.entries[key],
      !entry.file.isEmpty, !entry.file.contains("/"), !entry.file.hasPrefix(".")
    else { return nil }
    guard let data = try? Data(contentsOf: dir.appendingPathComponent(entry.file)),
      UIImage(data: data) != nil
    else { return nil }
    return data
  }

  // ── Fallback: initials on the agent colour ──────────────────────────

  static func initialsAvatar(title: String, colorHex: String) -> Data? {
    let letter = title.first.map { String($0).uppercased() } ?? "?"
    let fill = color(fromHex: colorHex) ?? UIColor(red: 0.42, green: 0.44, blue: 0.48, alpha: 1)
    let format = UIGraphicsImageRendererFormat.default()
    format.scale = 1
    format.opaque = false
    let size = CGSize(width: avatarSide, height: avatarSide)
    let renderer = UIGraphicsImageRenderer(size: size, format: format)
    return renderer.pngData { _ in
      fill.setFill()
      UIBezierPath(ovalIn: CGRect(origin: .zero, size: size)).fill()
      let font = UIFont.systemFont(ofSize: avatarSide * 0.46, weight: .semibold)
      let attrs: [NSAttributedString.Key: Any] = [
        .font: font,
        .foregroundColor: isLight(fill) ? UIColor(white: 0.1, alpha: 1) : UIColor.white,
      ]
      let text = letter as NSString
      let textSize = text.size(withAttributes: attrs)
      text.draw(
        at: CGPoint(x: (avatarSide - textSize.width) / 2, y: (avatarSide - textSize.height) / 2),
        withAttributes: attrs)
    }
  }

  /// `#RGB`, `#RRGGBB` or `#RRGGBBAA` (the `#` optional).
  static func color(fromHex hex: String) -> UIColor? {
    var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.hasPrefix("#") { s.removeFirst() }
    if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
    guard s.count == 6 || s.count == 8, let value = UInt64(s, radix: 16) else { return nil }
    let hasAlpha = s.count == 8
    let r = CGFloat((value >> (hasAlpha ? 24 : 16)) & 0xff) / 255
    let g = CGFloat((value >> (hasAlpha ? 16 : 8)) & 0xff) / 255
    let b = CGFloat((value >> (hasAlpha ? 8 : 0)) & 0xff) / 255
    let a = hasAlpha ? CGFloat(value & 0xff) / 255 : 1
    return UIColor(red: r, green: g, blue: b, alpha: a)
  }

  private static func isLight(_ color: UIColor) -> Bool {
    var r: CGFloat = 0
    var g: CGFloat = 0
    var b: CGFloat = 0
    var a: CGFloat = 0
    guard color.getRed(&r, green: &g, blue: &b, alpha: &a) else { return false }
    return 0.299 * r + 0.587 * g + 0.114 * b > 0.7
  }
}
