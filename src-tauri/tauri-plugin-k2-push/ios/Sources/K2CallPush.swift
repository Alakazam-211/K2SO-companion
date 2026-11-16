// DM calls' push in the app (K2 0.46.13 push kind `call`; brief
// companion-home-people-groups-brief-v1 §3). The Notification Service
// Extension shapes the push (NotificationService.swift `callContent`); this
// file is the app's side:
//
//   - The two categories. `K2_CALL` (the ring) carries Accept and Decline;
//     `K2_CALL_DONE` (the one push that replaces it: Answered on another
//     device / Missed call / Call ended) carries none. The NSE sets them on
//     every call push, so they work on a relay that doesn't send
//     `aps.category` (`call-aps`). KEEP THE IDS IN SYNC with the NSE.
//   - Accept (`.foreground`): opens the app; the tap goes to the webview
//     with `action: "accept"`, which joins `{dm}` (that join answers the
//     ring).
//   - Decline (background, no app on screen): `POST /cli/voice/call/decline
//     {dm, callId}` from here, on the server the sealed push came from, with
//     this phone's login there (the Keychain copy, K2SecureTokens) and the
//     server's address (`hosts`, written by Rust whenever the webview's
//     servers change). Without either (a push from before the first launch
//     that wrote them), the decline goes to the webview as a tap with
//     `action: "decline"`, which sends it when it runs.
//   - A tap (the notification itself): opens the app; the webview opens the
//     DM by `conversationId`.
//
// Not VoIP or CallKit in v1: the ring is a time-sensitive notification.

import Foundation
import UIKit
import UserNotifications

enum K2CallPush {
  static let ringCategory = "K2_CALL"
  static let doneCategory = "K2_CALL_DONE"
  static let acceptAction = "K2_CALL_ACCEPT"
  static let declineAction = "K2_CALL_DECLINE"
  /// Server id → base URL (`https://host`). Addresses only, no secret.
  static let hostsKey = "k2.call.hosts.v1"

  static func isCall(_ info: [AnyHashable: Any]) -> Bool {
    (info["kind"] as? String) == "call"
  }

  /// Once per launch, before any call push can be shown with its buttons.
  /// Keeps any other category the app may register.
  static func registerCategories() {
    let accept = UNNotificationAction(identifier: acceptAction, title: "Accept", options: [.foreground])
    let decline = UNNotificationAction(identifier: declineAction, title: "Decline", options: [.destructive])
    let ring = UNNotificationCategory(
      identifier: ringCategory, actions: [accept, decline], intentIdentifiers: [], options: [])
    let done = UNNotificationCategory(identifier: doneCategory, actions: [], intentIdentifiers: [], options: [])
    let center = UNUserNotificationCenter.current()
    center.getNotificationCategories { existing in
      var all = existing.filter { $0.identifier != ringCategory && $0.identifier != doneCategory }
      all.insert(ring)
      all.insert(done)
      center.setNotificationCategories(all)
    }
  }

  // ── The servers' addresses ───────────────────────────────────────────

  static func setHosts(_ hosts: [String: String]) {
    guard !hosts.isEmpty else { return }
    UserDefaults.standard.set(hosts, forKey: hostsKey)
  }

  static func hosts() -> [String: String] {
    UserDefaults.standard.dictionary(forKey: hostsKey) as? [String: String] ?? [:]
  }

  /// The saved server a call push came from: the sealed push's own key
  /// names it (`k2ServerId`, K2PushSealed); else the one saved server whose
  /// host is `<subdomain>.k2.dev` (the relay stamps `subdomain`).
  static func server(for info: [AnyHashable: Any], hosts: [String: String]) -> String? {
    if let id = info["k2ServerId"] as? String, hosts[id] != nil { return id }
    guard let sub = (info["subdomain"] as? String)?.lowercased(), !sub.isEmpty else { return nil }
    let hits = hosts.filter { URL(string: $0.value)?.host?.lowercased() == "\(sub).k2.dev" }
    return hits.count == 1 ? hits.first?.key : nil
  }

  private static func digits(_ v: Any?) -> String? {
    guard let s = (v as? String)?.trimmingCharacters(in: .whitespaces), !s.isEmpty,
      s.count <= 20, s.allSatisfy({ $0.isASCII && $0.isNumber })
    else { return nil }
    return s
  }

  // ── Decline in the background ───────────────────────────────────────

  enum DeclineOutcome: String {
    case declined
    case refused
    case failed
    /// No ids, server, address or login here: the webview has to send it.
    case unsendable
  }

  /// `POST /cli/voice/call/decline {dm, callId}` (Sew's call id) on the
  /// push's server. Calls `done` once, on any queue.
  static func decline(_ info: [AnyHashable: Any], done: @escaping (DeclineOutcome) -> Void) {
    guard let conv = digits(info["conversationId"]), let callId = digits(info["callId"]) else {
      done(.unsendable)
      return
    }
    let hosts = hosts()
    guard let server = server(for: info, hosts: hosts), let base = hosts[server],
      let url = URL(string: base.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/cli/voice/call/decline"),
      let token = K2SecureTokens.get(server: server),
      let body = try? JSONSerialization.data(withJSONObject: ["dm": conv, "callId": callId])
    else {
      done(.unsendable)
      return
    }
    var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
    req.httpMethod = "POST"
    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = body
    URLSession.shared.dataTask(with: req) { _, response, error in
      if error != nil {
        done(.failed)
        return
      }
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      done((200..<300).contains(status) ? .declined : .refused)
    }.resume()
  }
}
