import CryptoKit
import Foundation

enum HMACHelper {
  static func sha256Hex(secret: String, nonce: String) -> String {
    guard !secret.isEmpty else { return "" }
    let key = SymmetricKey(data: Data(secret.utf8))
    let code = HMAC<SHA256>.authenticationCode(for: Data(nonce.utf8), using: key)
    return code.map { String(format: "%02x", $0) }.joined()
  }
}
