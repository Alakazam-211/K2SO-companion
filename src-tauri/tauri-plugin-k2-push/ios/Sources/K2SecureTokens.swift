// Each server's login token in the Keychain, for native code that runs
// with the webview asleep: the voice call's join and renewal, from a
// CallKit button or in the background (gap list §7).
//
// A copy for now: the app's own store (`servers.json`) stays the source,
// and the app writes every change through (`setToken` / `removeToken`) and
// resyncs the whole set on launch. Readable after the first unlock, never
// synced or backed up off this phone.

import Foundation
import Security

public enum K2SecureTokens {
  static let service = "com.alakazamlabs.k2so.companion.login"

  static func query(_ server: String? = nil) -> [String: Any] {
    var q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
    ]
    if let server = server { q[kSecAttrAccount as String] = server }
    return q
  }

  @discardableResult
  public static func set(server: String, token: String) -> Bool {
    guard !server.isEmpty, !token.isEmpty, let data = token.data(using: .utf8) else { return false }
    let q = query(server)
    let update: [String: Any] = [kSecValueData as String: data]
    let status = SecItemUpdate(q as CFDictionary, update as CFDictionary)
    if status == errSecSuccess { return true }
    guard status == errSecItemNotFound else { return false }
    var add = q
    add[kSecValueData as String] = data
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
  }

  public static func remove(server: String) {
    guard !server.isEmpty else { return }
    SecItemDelete(query(server) as CFDictionary)
  }

  /// This server's token, or nil (none, or the phone not unlocked since boot).
  public static func get(server: String) -> String? {
    var q = query(server)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  /// The servers that have a token here (nil: the Keychain can't be read).
  public static func servers() -> [String]? {
    var q = query()
    q[kSecReturnAttributes as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitAll
    var out: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &out)
    if status == errSecItemNotFound { return [] }
    guard status == errSecSuccess, let rows = out as? [[String: Any]] else { return nil }
    return rows.compactMap { $0[kSecAttrAccount as String] as? String }
  }

  /// Make the Keychain hold exactly `tokens` (server id → token). Returns
  /// false when the Keychain can't be read yet; the next launch tries again.
  @discardableResult
  public static func sync(_ tokens: [String: String]) -> Bool {
    guard let held = servers() else { return false }
    for server in held where tokens[server] == nil { remove(server: server) }
    var ok = true
    for (server, token) in tokens where get(server: server) != token {
      ok = set(server: server, token: token) && ok
    }
    return ok
  }
}
