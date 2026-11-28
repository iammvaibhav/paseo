import ExpoModulesCore

public class PaseoMacWakeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PaseoMacWake")

    // The token is write-only from JS: only whether one is saved comes back.
    Function("getConfig") { () -> [String: Any?] in
      let config = MacWakeStore.load()
      return [
        "host": config?.host,
        "mac": config?.mac,
        "serverId": config?.serverId,
        "hasToken": MacWakeStore.hasToken,
      ]
    }

    AsyncFunction("saveConfig") { (host: String, mac: String, serverId: String, token: String?) in
      do {
        try MacWakeStore.save(host: host, mac: mac, serverId: serverId, token: token)
      } catch {
        throw MacWakeException(error.localizedDescription)
      }
    }

    AsyncFunction("clearConfig") {
      MacWakeStore.clear()
    }

    AsyncFunction("wake") { () async throws -> String in
      do {
        return MacWake.wakeMessage(try await MacWake.wake())
      } catch {
        throw MacWakeException(error.localizedDescription)
      }
    }

    AsyncFunction("letSleep") { () async throws -> String in
      do {
        return MacWake.sleepMessage(try await MacWake.letSleep())
      } catch {
        throw MacWakeException(error.localizedDescription)
      }
    }
  }
}

final class MacWakeException: GenericException<String> {
  override var reason: String { param }
}
