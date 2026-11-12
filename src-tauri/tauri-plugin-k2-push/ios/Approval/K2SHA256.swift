import CommonCrypto
import Foundation

/// SHA-256 without CryptoKit, so the macOS check builds on any macOS.
public enum K2SHA256 {
  public static func hash(_ data: Data) -> [UInt8] {
    var out = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
    data.withUnsafeBytes { _ = CC_SHA256($0.baseAddress, CC_LONG(data.count), &out) }
    return out
  }
}
