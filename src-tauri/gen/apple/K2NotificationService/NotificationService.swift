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
//
// Sealed alerts (K2 0.46.3 `push-e2e-v1`, `{kind:"e2e", v, e2e}` shown as
// "K2 / New message"): opened first with this phone's keys
// (K2PushSealed / K2PushKeys / K2PushReplay — shared sources, added by
// project.yml). Opened and fresh: the real title, body, group and today's
// userInfo keys replace the generic ones and everything below runs as for
// a plaintext push, except the Communication intent is donated with
// `content: nil` (the text stays out of the intents store). Not opened
// (before the first unlock, no key, a replay): the generic text as sent.
// A server the app marked sealed-only (`enforce`): its plaintext Thread /
// ticket / project pushes are shown generic.
//
// DM calls (K2 0.46.13 push kind `call`, always sealed in format 1): opened,
// `data` is `{kind: "call", callId (Sew's), conversationId, callState:
// ringing|missed|ended|answered}`. The ring (title the caller, body
// "Incoming call") gets category K2_CALL (Accept / Decline: the app
// registers them, K2CallPush.swift), K2's ringtone (`k2-ring.caf`, 28 s,
// the default sound when it isn't bundled) and a time-sensitive
// interruption level; the one push that replaces it (Answered on another
// device / Missed call / Call ended) gets K2_CALL_DONE and NO sound (it
// removes the ring first, which should cut a ringtone still playing).
//
// Ring for incoming calls (Settings → Calls, default on; the app stores it
// in the App Group's UserDefaults, `k2.call.ring.v1`, K2CallPush.setRing):
// off, the ring gets NO sound and the normal (active) level instead, still
// "Incoming call" with Accept / Decline; an unopened ring the same (on, it
// gets the ringtone at the level the relay sent). iOS's silent switch and
// Focus apply either way.
//
// The clear aps of a sealed call push (K2's answers §2): with the relay's
// `call-aps` cap, `alert` "K2 / New message", `sound` default,
// `mutable-content` 1, `category` K2_CALL, `interruption-level`
// time-sensitive (the done push: K2_CALL_DONE, and the relay's default
// sound). Without `call-aps` (an older relay, or the first ring after a
// daemon restart): only the alert, the sound and mutable-content. Both
// shapes end up the same here: everything is set on a `mutableCopy()`, so
// the server's level is kept when it sent one (never fresh content, which
// would drop it), and set when it didn't. The extension has the
// time-sensitive entitlement too (K2NotificationService.entitlements).
//
// Sealed pushes carry no apns-collapse-id, so APNs never replaces the ring:
// before a done push is shown, this extension removes every other delivered
// notification of the same call (matched by `callId` in the delivered,
// unsealed userInfo). One ring, then exactly one silent replacement.
// KEEP THE CATEGORY IDS IN SYNC with K2CallPush.swift.

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
    var incoming: UNNotificationContent = request.content
    var sealed = false
    if K2PushSealed.kind(of: incoming.userInfo) == .alert {
      guard case .success(let u) = K2PushSealed.unseal(incoming.userInfo),
        let m = incoming.mutableCopy() as? UNMutableNotificationContent
      else {
        // The generic "K2 / New message" as sent, except a call's clear
        // aps (`call-aps`): a done push stays silent, and a ring we can't
        // read has no Accept / Decline (nothing to answer them with).
        lock.lock()
        self.contentHandler = contentHandler
        lock.unlock()
        deliver(Self.unopenedCall(incoming) ?? incoming)
        return
      }
      m.title = u.title
      m.body = u.body
      if !u.group.isEmpty { m.threadIdentifier = u.group }
      m.userInfo = u.userInfo
      incoming = m
      sealed = true
      // The message itself, for the app to show on open (K2PushInbox).
      if let msg = u.msg, let e = K2PushInbox.entry(msg: msg, userInfo: u.userInfo) {
        K2PushInbox.append(e)
      }
    } else if K2PushSealed.enforced(incoming.userInfo),
      let kind = incoming.userInfo["kind"] as? String, ["thread", "ticket", "project"].contains(kind),
      let m = incoming.mutableCopy() as? UNMutableNotificationContent
    {
      m.title = "K2"
      m.body = "New message"
      incoming = m
    }

    // A DM call: its own shape, no Communication intent (no `addr`).
    if let call = Self.callContent(incoming) {
      lock.lock()
      self.contentHandler = contentHandler
      self.original = call
      lock.unlock()
      Self.clearOtherCallNotifications(call, keeping: request.identifier) {
        self.deliver(call)
      }
      return
    }

    // Badge first, so even the fallback paths carry it.
    let badge = Self.applyBadgeTotals(incoming.userInfo)
    let base = Self.withBadge(incoming, badge)

    lock.lock()
    self.contentHandler = contentHandler
    self.original = base
    lock.unlock()

    guard let built = Self.communicationIntent(for: incoming, sealed: sealed) else {
      deliver(base)
      return
    }
    let updated: UNNotificationContent
    do {
      updated = Self.withBadge(try incoming.updating(from: built), badge)
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

  // ── DM calls ────────────────────────────────────────────────────────

  static let callRingCategory = "K2_CALL"
  static let callDoneCategory = "K2_CALL_DONE"

  /// A call push's shape (nil: not a call). The server's title and body
  /// stand; the fallbacks are K2's own words.
  static func callContent(_ content: UNNotificationContent) -> UNNotificationContent? {
    let info = content.userInfo
    guard string(info, "kind") == "call",
      let m = content.mutableCopy() as? UNMutableNotificationContent
    else { return nil }
    let state = string(info, "callState")
    let callId = string(info, "callId")
    if !callId.isEmpty { m.threadIdentifier = "call:" + callId }
    if m.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { m.title = "K2" }
    if state.isEmpty || state == "ringing" {
      m.categoryIdentifier = callRingCategory
      if m.body.isEmpty { m.body = "Incoming call" }
      applyRingSound(m)
      m.relevanceScore = 1
    } else {
      m.categoryIdentifier = callDoneCategory
      if m.body.isEmpty {
        m.body = state == "answered" ? "Answered on another device" : state == "missed" ? "Missed call" : "Call ended"
      }
      // The relay's clear aps gives every sealed push the default sound:
      // the replacement must not ring again. Passive, as K2 0.46.13 sends
      // it with call-aps (no screen wake); set here so a relay without
      // call-aps behaves the same.
      m.sound = nil
      m.interruptionLevel = .passive
    }
    return m
  }

  /// A sealed push we couldn't open, by its clear `call-aps` category (nil:
  /// not a call, or nothing to change). Its level stays as sent.
  static func unopenedCall(_ content: UNNotificationContent) -> UNNotificationContent? {
    let category = content.categoryIdentifier
    guard category == callRingCategory || category == callDoneCategory,
      let m = content.mutableCopy() as? UNMutableNotificationContent
    else { return nil }
    if category == callDoneCategory {
      m.sound = nil
      m.interruptionLevel = .passive
    } else {
      m.categoryIdentifier = ""
      if ringOn() {
        m.sound = ringSound()
      } else {
        m.sound = nil
        m.interruptionLevel = .active
      }
    }
    return m
  }

  /// Settings → Calls → Ring for incoming calls, as the app stored it in
  /// the App Group (K2CallPush.ringKey — KEEP THE KEY IN SYNC). Never
  /// written (or no App Group): ring.
  static let ringKey = "k2.call.ring.v1"

  static func ringOn() -> Bool {
    UserDefaults(suiteName: appGroupId)?.object(forKey: ringKey) as? Bool ?? true
  }

  /// K2's ringtone (scripts/gen-ringtone.mjs, 28 s: iOS plays it once, up
  /// to 30 s), bundled in the app and in this extension (project.yml). Not
  /// in this bundle (a build without it): the default sound.
  static let ringFile = "k2-ring.caf"

  static func ringSound() -> UNNotificationSound {
    guard Bundle.main.url(forResource: "k2-ring", withExtension: "caf") != nil else { return .default }
    return UNNotificationSound(named: UNNotificationSoundName(ringFile))
  }

  /// A ring: on = K2's ringtone, time-sensitive; off = no sound at the
  /// normal level, still shown with Accept / Decline.
  static func applyRingSound(_ m: UNMutableNotificationContent) {
    if ringOn() {
      m.sound = ringSound()
      m.interruptionLevel = .timeSensitive
    } else {
      m.sound = nil
      m.interruptionLevel = .active
    }
  }

  /// A done push: the call's other notifications still delivered go first
  /// (the ring, when a relay lost the collapse id). `done` runs once.
  static func clearOtherCallNotifications(
    _ content: UNNotificationContent, keeping identifier: String, done: @escaping () -> Void
  ) {
    let callId = string(content.userInfo, "callId")
    guard content.categoryIdentifier == callDoneCategory, !callId.isEmpty else {
      done()
      return
    }
    let center = UNUserNotificationCenter.current()
    center.getDeliveredNotifications { delivered in
      let ids = delivered
        .filter {
          $0.request.identifier != identifier && string($0.request.content.userInfo, "kind") == "call"
            && string($0.request.content.userInfo, "callId") == callId
        }
        .map { $0.request.identifier }
      if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
      done()
    }
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
  static func communicationIntent(for content: UNNotificationContent, sealed: Bool = false) -> INSendMessageIntent? {
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
      // Sealed: the decrypted text is shown, never donated (prd V28).
      content: sealed ? nil : content.body,
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
