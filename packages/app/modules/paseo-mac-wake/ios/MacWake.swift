import CryptoKit
import Foundation
import Network
import Security

// Wakes a sleeping Mac from the iPhone and asks lidwake on that Mac to keep it awake.
//
// lidwake (a LaunchAgent on the Mac, TCP 47010) takes a short pre-hold after every Wi-Fi
// wake, because a network DarkWake on battery lasts only ~6 s. The phone must therefore
// send the magic packet and reach GET /challenge inside that window; a challenge extends
// the pre-hold, and a signed GET /hold keeps the Mac awake until GET /release.
// Signature: sha256_hex("<token>:<action>:<nonce>"). The token never leaves the phone.

public struct MacWakeConfig: Equatable {
  public var host: String
  public var mac: String
  /// The Paseo host the settings card belongs to, so the buttons show on that host only.
  public var serverId: String?

  public init(host: String, mac: String, serverId: String?) {
    self.host = host
    self.mac = mac
    self.serverId = serverId
  }
}

public struct MacWakeStatus: Equatable {
  public let held: Bool
  public let phoneHold: Bool
  public let holdUntil: String?
  public let agentsRunning: Bool
  public let onBattery: Bool
  public let battery: Int?

  init(json: [String: Any]) {
    held = json["held"] as? Bool ?? false
    phoneHold = json["phoneHold"] as? Bool ?? false
    holdUntil = json["holdUntil"] as? String
    agentsRunning = json["agentsRunning"] as? Bool ?? false
    onBattery = json["onBattery"] as? Bool ?? false
    battery = json["battery"] as? Int
  }
}

public enum MacWakeError: Error, LocalizedError, CustomLocalizedStringResourceConvertible {
  case notConfigured
  case invalidHost
  case invalidMac
  case localNetworkUnavailable(String)
  case noAnswer(seconds: Int)
  case rejected(String)
  case badResponse(String)

  public var errorDescription: String? {
    switch self {
    case .notConfigured:
      return "Wake Mac isn't set up. Open Paseo › Settings › your Mac's host and set it up."
    case .invalidHost:
      return "The Mac's IP address isn't valid."
    case .invalidMac:
      return "The MAC address isn't valid. Use six hex pairs, like ce:13:8b:1e:5b:10."
    case .localNetworkUnavailable(let detail):
      return "Paseo can't reach the local network (\(detail)). Allow Local Network for Paseo in iOS Settings › Privacy & Security › Local Network."
    case .noAnswer(let seconds):
      return "The Mac didn't answer within \(seconds) s. Check that the iPhone is on the Mac's Wi-Fi and the Mac's IP address is right."
    case .rejected(let reason):
      return "The Mac refused the request: \(reason). Check the token."
    case .badResponse(let detail):
      return "Unexpected reply from the Mac: \(detail)"
    }
  }

  public var localizedStringResource: LocalizedStringResource {
    LocalizedStringResource(stringLiteral: errorDescription ?? "Wake Mac failed")
  }
}

public enum MacWakeProtocol {
  public static let port: UInt16 = 47010
  public static let wakeOnLanPort: UInt16 = 9

  /// Six bytes from `aa:bb:cc:dd:ee:ff`, `aa-bb-…` or `aabbccddeeff`; nil otherwise.
  public static func parseMac(_ text: String) -> [UInt8]? {
    let hex = text.trimmingCharacters(in: .whitespaces).lowercased()
      .replacingOccurrences(of: ":", with: "").replacingOccurrences(of: "-", with: "")
    guard hex.count == 12, hex.allSatisfy(\.isHexDigit) else { return nil }
    var bytes: [UInt8] = []
    var index = hex.startIndex
    while index < hex.endIndex {
      let next = hex.index(index, offsetBy: 2)
      guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
      bytes.append(byte)
      index = next
    }
    return bytes
  }

  public static func formatMac(_ bytes: [UInt8]) -> String {
    bytes.map { String(format: "%02x", $0) }.joined(separator: ":")
  }

  /// 6 × 0xFF, then the MAC 16 times (102 bytes).
  public static func magicPacket(mac: [UInt8]) -> Data {
    var packet = Data(repeating: 0xFF, count: 6)
    for _ in 0..<16 { packet.append(contentsOf: mac) }
    return packet
  }

  public static func signature(token: String, action: String, nonce: String) -> String {
    SHA256.hash(data: Data("\(token):\(action):\(nonce)".utf8))
      .map { String(format: "%02x", $0) }.joined()
  }
}

public final class MacWakeClient {
  private let host: String
  private let mac: [UInt8]
  private let token: String
  private let port: UInt16
  private let wakeOnLanPort: UInt16
  private let session: URLSession

  public init(
    host: String, mac: [UInt8], token: String,
    port: UInt16 = MacWakeProtocol.port, wakeOnLanPort: UInt16 = MacWakeProtocol.wakeOnLanPort
  ) {
    self.host = host
    self.mac = mac
    self.token = token
    self.port = port
    self.wakeOnLanPort = wakeOnLanPort
    let configuration = URLSessionConfiguration.ephemeral
    // A sleeping Mac drops the SYN; fail fast and retry instead of waiting out TCP backoff.
    configuration.timeoutIntervalForRequest = 2.5
    configuration.timeoutIntervalForResource = 5
    configuration.waitsForConnectivity = false
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    session = URLSession(configuration: configuration)
  }

  deinit { session.invalidateAndCancel() }

  /// Magic packets, then /challenge until the Mac answers (up to `budget` seconds), then /hold.
  public func wake(budget: TimeInterval = 30) async throws -> MacWakeStatus {
    let sender = try await MagicPacketSender.open(host: host, port: wakeOnLanPort)
    defer { sender.close() }
    let packet = MacWakeProtocol.magicPacket(mac: mac)
    for attempt in 0..<4 {
      if attempt > 0 { try await Task.sleep(nanoseconds: 200_000_000) }
      await sender.send(packet)
    }
    return try await signed("hold", budget: budget) {
      // Each retry re-sends the packet in case the first burst was lost.
      await sender.send(packet)
    }
  }

  public func letSleep(budget: TimeInterval = 8) async throws -> MacWakeStatus {
    try await signed("release", budget: budget, beforeRetry: {})
  }

  public func status(budget: TimeInterval = 8) async throws -> MacWakeStatus {
    try await signed("status", budget: budget, beforeRetry: {})
  }

  private func signed(
    _ action: String, budget: TimeInterval, beforeRetry: () async -> Void
  ) async throws -> MacWakeStatus {
    let deadline = Date().addingTimeInterval(budget)
    var attempt = 0
    while true {
      if attempt > 0 {
        if Date() >= deadline { throw MacWakeError.noAnswer(seconds: Int(budget.rounded())) }
        await beforeRetry()
        try await Task.sleep(nanoseconds: 500_000_000)
      }
      attempt += 1
      guard let challenge = try await get("challenge", query: [:]) else { continue }
      guard let nonce = challenge["nonce"] as? String, !nonce.isEmpty else {
        throw MacWakeError.badResponse("no nonce in /challenge")
      }
      let sig = MacWakeProtocol.signature(token: token, action: action, nonce: nonce)
      // A transport failure here (the Mac fell asleep between the calls) retries with a fresh
      // nonce; a 403 is final.
      guard let reply = try await get(action, query: ["nonce": nonce, "sig": sig]) else {
        continue
      }
      return MacWakeStatus(json: reply)
    }
  }

  /// The JSON body of a 200; nil when the Mac can't be reached; throws for anything else.
  private func get(_ action: String, query: [String: String]) async throws -> [String: Any]? {
    var components = URLComponents()
    components.scheme = "http"
    components.host = host
    components.port = Int(port)
    components.path = "/\(action)"
    if !query.isEmpty {
      components.queryItems = query.sorted { $0.key < $1.key }
        .map { URLQueryItem(name: $0.key, value: $0.value) }
    }
    guard let url = components.url else { throw MacWakeError.invalidHost }
    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(from: url)
    } catch {
      return nil
    }
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    if status == 200, let json { return json }
    if status == 403 { throw MacWakeError.rejected(json?["error"] as? String ?? "forbidden") }
    throw MacWakeError.badResponse("HTTP \(status) from /\(action)")
  }
}

/// Unicast UDP. Broadcast would need the multicast entitlement, which a free Apple ID can't get.
final class MagicPacketSender {
  private let connection: NWConnection

  private init(connection: NWConnection) { self.connection = connection }

  static func open(host: String, port: UInt16) async throws -> MagicPacketSender {
    guard let nwPort = NWEndpoint.Port(rawValue: port) else { throw MacWakeError.invalidHost }
    let connection = NWConnection(host: NWEndpoint.Host(host), port: nwPort, using: .udp)
    let queue = DispatchQueue(label: "sh.paseo.mac-wake.udp")
    // UDP is ready at once unless iOS blocks local network access; the first use may wait on
    // the permission prompt, so allow time for the user to answer it.
    let ready = ReadyLatch()
    connection.stateUpdateHandler = { state in
      switch state {
      case .ready: ready.finish(nil)
      case .failed(let error): ready.finish(error.localizedDescription)
      case .waiting(let error): ready.note(error.localizedDescription)
      default: break
      }
    }
    connection.start(queue: queue)
    if let failure = await ready.wait(timeout: 15) {
      connection.cancel()
      throw MacWakeError.localNetworkUnavailable(failure)
    }
    return MagicPacketSender(connection: connection)
  }

  /// Errors are ignored: an awake Mac answers UDP 9 with ICMP port unreachable, which makes the
  /// next send on this connected socket fail with ECONNREFUSED. That only proves it is up.
  func send(_ data: Data) async {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      connection.send(content: data, completion: .contentProcessed { _ in continuation.resume() })
    }
  }

  func close() { connection.cancel() }
}

/// Resolves once with nil (ready) or a failure description, or with the last waiting reason at
/// the timeout.
private final class ReadyLatch: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<String?, Never>?
  private var result: String??
  private var waitingReason: String?

  func note(_ reason: String) {
    lock.lock()
    waitingReason = reason
    lock.unlock()
  }

  func finish(_ failure: String?) {
    lock.lock()
    guard result == nil else { lock.unlock(); return }
    result = .some(failure)
    let pending = continuation
    continuation = nil
    lock.unlock()
    pending?.resume(returning: failure)
  }

  func wait(timeout: TimeInterval) async -> String? {
    DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [weak self] in
      guard let self else { return }
      self.lock.lock()
      let reason = self.waitingReason ?? "no route after \(Int(timeout)) s"
      self.lock.unlock()
      self.finish(reason)
    }
    return await withCheckedContinuation { continuation in
      lock.lock()
      if let result {
        lock.unlock()
        continuation.resume(returning: result)
        return
      }
      self.continuation = continuation
      lock.unlock()
    }
  }
}

/// IP and MAC in UserDefaults; the token in the Keychain, readable after first unlock so Siri
/// and Shortcuts work while the phone is locked.
public enum MacWakeStore {
  private static let hostKey = "paseo.macWake.host"
  private static let macKey = "paseo.macWake.mac"
  private static let serverIdKey = "paseo.macWake.serverId"
  private static let keychainService = "sh.paseo.mac-wake"
  private static let keychainAccount = "lidwake-token"

  public static func load() -> MacWakeConfig? {
    let defaults = UserDefaults.standard
    guard let host = defaults.string(forKey: hostKey), let mac = defaults.string(forKey: macKey)
    else { return nil }
    return MacWakeConfig(host: host, mac: mac, serverId: defaults.string(forKey: serverIdKey))
  }

  /// Validates and normalizes; `token` nil keeps the saved one.
  public static func save(host: String, mac: String, serverId: String?, token: String?) throws {
    let trimmedHost = host.trimmingCharacters(in: .whitespaces)
    guard !trimmedHost.isEmpty, !trimmedHost.contains(" ") else { throw MacWakeError.invalidHost }
    guard let bytes = MacWakeProtocol.parseMac(mac) else { throw MacWakeError.invalidMac }
    if let token {
      try setToken(token.trimmingCharacters(in: .whitespacesAndNewlines))
    }
    let defaults = UserDefaults.standard
    defaults.set(trimmedHost, forKey: hostKey)
    defaults.set(MacWakeProtocol.formatMac(bytes), forKey: macKey)
    defaults.set(serverId, forKey: serverIdKey)
  }

  public static func clear() {
    let defaults = UserDefaults.standard
    defaults.removeObject(forKey: hostKey)
    defaults.removeObject(forKey: macKey)
    defaults.removeObject(forKey: serverIdKey)
    SecItemDelete(baseQuery() as CFDictionary)
  }

  public static var hasToken: Bool { token() != nil }

  static func token() -> String? {
    var query = baseQuery()
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
      let data = item as? Data, let token = String(data: data, encoding: .utf8), !token.isEmpty
    else { return nil }
    return token
  }

  private static func setToken(_ token: String) throws {
    SecItemDelete(baseQuery() as CFDictionary)
    guard !token.isEmpty else { return }
    var item = baseQuery()
    item[kSecValueData as String] = Data(token.utf8)
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let status = SecItemAdd(item as CFDictionary, nil)
    guard status == errSecSuccess else {
      throw MacWakeError.badResponse("Keychain refused the token (OSStatus \(status))")
    }
  }

  private static func baseQuery() -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: keychainService,
      kSecAttrAccount as String: keychainAccount,
    ]
  }
}

/// What the app's buttons and the App Intents run, with the wording both show.
public enum MacWake {
  public static func wake() async throws -> MacWakeStatus {
    try await client().wake()
  }

  public static func letSleep() async throws -> MacWakeStatus {
    try await client().letSleep()
  }

  public static func wakeMessage(_ status: MacWakeStatus) -> String {
    guard let until = status.holdUntil else { return "The Mac is awake, but no hold was placed." }
    return "Mac awake until \(until)\(batterySuffix(status))."
  }

  public static func sleepMessage(_ status: MacWakeStatus) -> String {
    if status.agentsRunning { return "Hold released. The Mac stays up while Paseo agents run." }
    if status.held { return "Hold released. The Mac stays up for another demand." }
    return "Hold released. The Mac can sleep now."
  }

  private static func batterySuffix(_ status: MacWakeStatus) -> String {
    guard status.onBattery, let battery = status.battery else { return "" }
    return " (battery \(battery)%)"
  }

  private static func client() throws -> MacWakeClient {
    guard let config = MacWakeStore.load(), let token = MacWakeStore.token() else {
      throw MacWakeError.notConfigured
    }
    guard let mac = MacWakeProtocol.parseMac(config.mac) else { throw MacWakeError.invalidMac }
    return MacWakeClient(host: config.host, mac: mac, token: token)
  }
}
