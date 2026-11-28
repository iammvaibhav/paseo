// Compiled with ../ios/MacWake.swift into one macOS binary by run-on-mac.sh.
// Env: MOCK_HTTP_PORT, MOCK_UDP_PORT (mock_lidwake.py), optional LIVE_HOST + LIVE_TOKEN_FILE for
// the real lidwake, LIVE_HOLD=1 to also place and release a hold there.
import Foundation

var failures = 0
func check(_ condition: Bool, _ label: String) {
  print("\(condition ? "PASS" : "FAIL") \(label)")
  if !condition { failures += 1 }
}

let env = ProcessInfo.processInfo.environment
let mac: [UInt8] = [0xce, 0x13, 0x8b, 0x1e, 0x5b, 0x10]

// Protocol
check(MacWakeProtocol.parseMac("CE:13:8B:1E:5B:10") == mac, "parses a colon MAC")
check(MacWakeProtocol.parseMac("ce-13-8b-1e-5b-10") == mac, "parses a dash MAC")
check(MacWakeProtocol.parseMac("ce138b1e5b10") == mac, "parses a bare MAC")
check(MacWakeProtocol.parseMac("ce:13:8b:1e:5b") == nil, "rejects a short MAC")
check(MacWakeProtocol.parseMac("zz:13:8b:1e:5b:10") == nil, "rejects non-hex")
let packet = MacWakeProtocol.magicPacket(mac: mac)
check(packet.count == 102, "magic packet is 102 bytes")
check(packet.prefix(6).allSatisfy { $0 == 0xFF }, "magic packet starts with 6×FF")
check(
  (0..<16).allSatisfy { Array(packet[(6 + $0 * 6)..<(12 + $0 * 6)]) == mac },
  "magic packet repeats the MAC 16 times")
// printf 'tok:hold:abc' | sha256sum
check(
  MacWakeProtocol.signature(token: "tok", action: "hold", nonce: "abc")
    == "1c1fc4da2bbe21e0fb78498e872409549bdaaad625510b5e7fcdc83001180102",
  "signature is sha256 hex of token:action:nonce")

// Mock: asleep until the magic packet, then lidwake's protocol.
let httpPort = UInt16(env["MOCK_HTTP_PORT"]!)!
let udpPort = UInt16(env["MOCK_UDP_PORT"]!)!
let client = MacWakeClient(
  host: "127.0.0.1", mac: mac, token: "tok", port: httpPort, wakeOnLanPort: udpPort)
let started = Date()
do {
  let status = try await client.wake(budget: 30)
  check(status.phoneHold && status.holdUntil == "23:59", "wake: hold placed after the mock woke")
  check(MacWake.wakeMessage(status) == "Mac awake until 23:59 (battery 42%).", "wake message")
  print("     wake took \(String(format: "%.1f", Date().timeIntervalSince(started))) s")
} catch {
  check(false, "wake: \(error.localizedDescription)")
}
do {
  let status = try await client.letSleep()
  check(!status.phoneHold, "let sleep: hold released")
  check(MacWake.sleepMessage(status) == "Hold released. The Mac can sleep now.", "sleep message")
} catch {
  check(false, "let sleep: \(error.localizedDescription)")
}
do {
  _ = try await MacWakeClient(
    host: "127.0.0.1", mac: mac, token: "wrong", port: httpPort, wakeOnLanPort: udpPort
  ).status()
  check(false, "wrong token is rejected")
} catch MacWakeError.rejected(let reason) {
  check(reason == "bad signature", "wrong token is rejected (\(reason))")
} catch {
  check(false, "wrong token is rejected: \(error.localizedDescription)")
}
let unreachable = Date()
do {
  _ = try await MacWakeClient(host: "127.0.0.1", mac: mac, token: "tok", port: 1).status(budget: 3)
  check(false, "unreachable Mac gives up")
} catch MacWakeError.noAnswer(let seconds) {
  let took = Date().timeIntervalSince(unreachable)
  check(seconds == 3 && took < 8, "unreachable Mac gives up after the budget (\(Int(took)) s)")
} catch {
  check(false, "unreachable Mac gives up: \(error.localizedDescription)")
}

// The real lidwake. status is signed and changes nothing.
if let liveHost = env["LIVE_HOST"], let tokenFile = env["LIVE_TOKEN_FILE"] {
  let token = try String(contentsOfFile: tokenFile, encoding: .utf8)
    .trimmingCharacters(in: .whitespacesAndNewlines)
  let live = MacWakeClient(host: liveHost, mac: mac, token: token)
  do {
    let status = try await live.status()
    check(true, "live \(liveHost): signed status accepted (phoneHold=\(status.phoneHold), battery=\(status.battery.map(String.init) ?? "-"))")
    if env["LIVE_HOLD"] == "1" && !status.phoneHold {
      let held = try await live.wake(budget: 10)
      check(held.phoneHold && held.holdUntil != nil, "live: hold placed until \(held.holdUntil ?? "-")")
      let released = try await live.letSleep()
      check(!released.phoneHold, "live: hold released")
    }
  } catch {
    check(false, "live \(liveHost): \(error.localizedDescription)")
  }
}

print(failures == 0 ? "ALL PASS" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
