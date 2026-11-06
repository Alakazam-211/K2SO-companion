// A recording notice that needs the person's answer while the app is in
// the background (a CallKit call keeps it running): one local notification,
// replaced by a newer notice and taken away once the notice is answered,
// cleared, or the call ends. Rust decides when (voice.rs `Watch`); this
// file only posts and removes.
//
// Never asks for notification permission: push already did, and a refusal
// stands. A tap only opens the app: the call's resync shows the sheet. The
// push tap path never sees it (`isOurs`).

import Foundation
import UIKit
import UserNotifications

enum K2CallNotice {
  /// One at a time: a newer notice replaces the last.
  static let id = "k2.voice.recording"
  /// `userInfo.kind`, so nothing reads it as a push.
  static let kind = "voice_recording"

  private static let queue = DispatchQueue(label: "k2.call-notice")
  /// Bumped by every post and clear: a post still waiting on the main
  /// thread or the settings read gives up once something newer came.
  private static var generation = 0

  static func isOurs(_ notification: UNNotification) -> Bool {
    notification.request.identifier == id
  }

  static func post(title: String, body: String) {
    queue.async {
      generation += 1
      let mine = generation
      DispatchQueue.main.async {
        // In the foreground the sheet itself is on screen.
        guard UIApplication.shared.applicationState != .active else { return }
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
          guard allowed(settings.authorizationStatus) else { return }
          let content = UNMutableNotificationContent()
          content.title = title
          content.body = body
          content.sound = .default
          content.threadIdentifier = id
          content.userInfo = ["kind": kind]
          queue.async {
            guard generation == mine else { return }
            center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
          }
        }
      }
    }
  }

  static func clear() {
    queue.async {
      generation += 1
      let center = UNUserNotificationCenter.current()
      center.removePendingNotificationRequests(withIdentifiers: [id])
      center.removeDeliveredNotifications(withIdentifiers: [id])
    }
  }

  private static func allowed(_ status: UNAuthorizationStatus) -> Bool {
    switch status {
    case .authorized, .provisional: return true
    default:
      if #available(iOS 14.0, *), status == .ephemeral { return true }
      return false
    }
  }
}
