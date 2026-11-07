import { once } from "node:events";
import net from "node:net";
import type { Logger } from "pino";

interface ProxyEntry {
  server: net.Server;
  proxyPort: number;
  /** Client addresses that asked for this port. Loopback is always admitted. */
  allowed: Set<string>;
}

/** At most this many target ports are exposed at once; the oldest closes first. */
const MAX_PROXIES = 16;
/** Dev servers bind `localhost`, which can mean 127.0.0.1 or ::1. */
const UPSTREAM_HOSTS = ["127.0.0.1", "::1"];

function normalizeAddress(address: string): string {
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

function isLoopback(address: string): boolean {
  return address === "::1" || address.startsWith("127.");
}

/**
 * Exposes a port on the daemon's loopback (a dev server an agent started) to a client that
 * renders a `show_page` URL. Each target port gets one raw TCP listener on the daemon's
 * listen host, so HTTP, WebSockets, and root-relative asset paths work unchanged.
 *
 * A dev server has no auth of its own, so a listener admits only loopback and the client
 * addresses that opened it over an authenticated daemon session.
 */
export class PagePortProxy {
  private readonly entries = new Map<number, Promise<ProxyEntry>>();

  constructor(
    private readonly options: {
      logger: Logger;
      /** The host the daemon listens on, such as `0.0.0.0` or a VPN address. */
      getBindHost: () => string;
    },
  ) {}

  async open(input: { port: number; clientAddress: string }): Promise<number> {
    let pending = this.entries.get(input.port);
    if (!pending) {
      pending = this.listen(input.port);
      this.entries.set(input.port, pending);
      pending.catch(() => this.entries.delete(input.port));
      this.evictOldest();
    }
    const entry = await pending;
    entry.allowed.add(normalizeAddress(input.clientAddress));
    return entry.proxyPort;
  }

  /** Stops accepting connections. Open connections end when either side closes them. */
  async close(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(
      entries.map((pending) =>
        pending.then(
          (entry) => entry.server.close(),
          () => undefined,
        ),
      ),
    );
  }

  private evictOldest(): void {
    for (const [port, pending] of this.entries) {
      if (this.entries.size <= MAX_PROXIES) return;
      this.entries.delete(port);
      void pending.then(
        (entry) => entry.server.close(),
        () => undefined,
      );
    }
  }

  private async listen(targetPort: number): Promise<ProxyEntry> {
    const allowed = new Set<string>();
    const { logger } = this.options;
    const server = net.createServer((socket) => {
      const remote = normalizeAddress(socket.remoteAddress ?? "");
      if (!isLoopback(remote) && !allowed.has(remote)) {
        socket.destroy();
        return;
      }
      connectUpstream(targetPort, socket, logger, UPSTREAM_HOSTS);
    });
    server.listen(0, this.options.getBindHost());
    await once(server, "listening");
    server.on("error", (error) => {
      logger.warn({ err: error, targetPort }, "Page proxy listener error");
    });
    const address = server.address();
    if (!address || typeof address !== "object") {
      server.close();
      throw new Error("Page proxy listener has no TCP address");
    }
    logger.info({ targetPort, proxyPort: address.port }, "Page proxy opened");
    return { server, proxyPort: address.port, allowed };
  }
}

function connectUpstream(
  port: number,
  client: net.Socket,
  logger: Logger,
  hosts: readonly string[],
): void {
  const [host, ...fallbacks] = hosts;
  let connected = false;
  const upstream = net.connect({ host, port });
  const destroyUpstream = () => upstream.destroy();
  client.on("error", destroyUpstream);
  client.on("close", destroyUpstream);
  upstream.once("connect", () => {
    connected = true;
    client.pipe(upstream);
    upstream.pipe(client);
  });
  upstream.on("error", (error) => {
    if (!connected && fallbacks.length > 0) {
      client.off("error", destroyUpstream);
      client.off("close", destroyUpstream);
      connectUpstream(port, client, logger, fallbacks);
      return;
    }
    logger.debug({ err: error, port }, "Page proxy upstream unreachable");
    client.destroy();
  });
}
