// Delivered-notification clearing: a Thread or project chat read on
// another device (or here) leaves Notification Center too.
//
// Callers:
//   - the app, through `clearDelivered` (`lib/deliveredClear.ts`): a
//     `thread_read` / `project_read` frame or reply (`read`), and the
//     unread summary on open / foreground (`keepOnly`);
//   - the silent badge push (`K2PushPlugin.handleRemoteNotification`):
//     `unreadTotal` 0 clears that server; K2 0.46.8 `push-read-hints-v1`
//     `read` pairs clear those chats.
//
// A notification belongs to a server by its `badgeKey` (K2 0.46.1), else
// its `subdomain`, else its `instanceId` (each only when both sides have
// one: a daemon without a salt or a paired tunnel sends ""); to a chat by
// `kind` + `conversationId` (thread) or `groupId` (project). Only `thread`
// and `project` notifications are ever removed: tickets are not read
// state. A notification without a `seq` (project alerts before K2 0.46.8
// D4) is only removed when it was delivered before the state that clears
// it. A generic-lane alert (sealed-only server, no key here) names no chat:
// it goes only when the server has nothing unread left.

import Foundation
import UserNotifications

enum K2DeliveredClear {
  struct Server {
    var badgeKey: String?
    var subdomain: String?
    var instanceId: String? = nil
  }

  struct Chat: Equatable {
    /// "thread" or "project".
    var kind: String
    var id: String
    /// Read up to here; nil = all of it.
    var seq: Int?
  }

  enum Op {
    /// These chats were read up to their seq.
    case read([Chat])
    /// Only these chats still have something unread, above their seq:
    /// every other Thread / project notification from the server goes.
    case keepOnly([Chat])
  }

  /// One delivered notification, as the matcher sees it.
  struct Note {
    var id: String
    var info: [AnyHashable: Any]
    var date: Date
  }

  // ── Matching (pure) ─────────────────────────────────────────────────

  private static func str(_ v: Any?) -> String? {
    if let s = v as? String, !s.isEmpty { return s }
    if let n = v as? NSNumber { return n.stringValue }
    return nil
  }

  static func serverMatches(_ info: [AnyHashable: Any], _ server: Server) -> Bool {
    let pairs: [(String?, String?)] = [
      (server.badgeKey, str(info["badgeKey"])),
      (server.subdomain, str(info["subdomain"])),
      (server.instanceId, str(info["instanceId"])),
    ]
    for (mine, theirs) in pairs {
      if let mine = mine?.lowercased(), !mine.isEmpty, let theirs = theirs?.lowercased() {
        return mine == theirs
      }
    }
    return false
  }

  /// A Thread / project-chat notification: its chat (nil id = a generic
  /// alert that names none). Nil for anything else (tickets).
  static func chatOf(_ info: [AnyHashable: Any]) -> (kind: String, id: String?, seq: Int?)? {
    let seq = str(info["seq"]).flatMap { Int($0) }
    switch str(info["kind"]) {
    case "thread": return ("thread", str(info["conversationId"]), seq)
    case "project": return ("project", str(info["groupId"]), seq)
    default: return nil
    }
  }

  /// Is a notification at `noteSeq`, delivered at `date`, covered by a
  /// read up to `readSeq` (nil = everything) as of `before`?
  private static func covered(noteSeq: Int?, date: Date, readSeq: Int?, before: Date) -> Bool {
    if let noteSeq = noteSeq, let readSeq = readSeq { return noteSeq <= readSeq }
    return date <= before
  }

  /// The identifiers to remove.
  static func toRemove(_ notes: [Note], server: Server, op: Op, before: Date) -> [String] {
    notes.compactMap { n in
      guard serverMatches(n.info, server), let chat = chatOf(n.info) else { return nil }
      switch op {
      case .read(let chats):
        guard let id = chat.id, let hit = chats.first(where: { $0.kind == chat.kind && $0.id == id }) else { return nil }
        return covered(noteSeq: chat.seq, date: n.date, readSeq: hit.seq, before: before) ? n.id : nil
      case .keepOnly(let unread):
        // Newer than the state: not ours to judge.
        guard n.date <= before else { return nil }
        guard let id = chat.id else { return unread.isEmpty ? n.id : nil }
        guard let left = unread.first(where: { $0.kind == chat.kind && $0.id == id }) else { return n.id }
        guard let readSeq = left.seq, let noteSeq = chat.seq else { return nil }
        return noteSeq <= readSeq ? n.id : nil
      }
    }
  }

  /// `"t:<conversationId>:<seq>,p:<groupId>:<seq>"` (K2 0.46.8
  /// `push-read-hints-v1`): kind before the first ':', seq after the last.
  static func parseReadHints(_ raw: Any?) -> [Chat] {
    guard let s = raw as? String else { return [] }
    return s.split(separator: ",").compactMap { part in
      let p = String(part)
      guard let first = p.firstIndex(of: ":"), let last = p.lastIndex(of: ":"), first < last else { return nil }
      let kind: String
      switch p[..<first] {
      case "t": kind = "thread"
      case "p": kind = "project"
      default: return nil
      }
      let id = String(p[p.index(after: first)..<last])
      guard !id.isEmpty, let seq = Int(p[p.index(after: last)...]), seq >= 0 else { return nil }
      return Chat(kind: kind, id: id, seq: seq)
    }
  }

  // ── Notification Center ─────────────────────────────────────────────

  /// Remove what `op` covers; `completion` gets the count (on any queue).
  static func clear(server: Server, op: Op, before: Date = Date(), completion: ((Int) -> Void)? = nil) {
    let center = UNUserNotificationCenter.current()
    center.getDeliveredNotifications { delivered in
      let notes = delivered.map {
        Note(id: $0.request.identifier, info: $0.request.content.userInfo, date: $0.date)
      }
      let ids = toRemove(notes, server: server, op: op, before: before)
      if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
      completion?(ids.count)
    }
  }
}
