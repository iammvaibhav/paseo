import { type ChildProcess, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "pino";
import type { WebhookTunnelProvider, WebhookTunnelStatus } from "@getpaseo/protocol/webhook/types";

const execFileAsync = promisify(execFile);

export interface TunnelConfig {
  provider: WebhookTunnelProvider;
  localPort: number;
  // host:port the tunnel forwards to (the daemon's actual bound address).
  localTarget: string;
  autoStart: boolean;
  publicBaseUrl: string | null;
  tailscaleBin: string | null;
  cloudflared: {
    hostname: string | null;
    bin: string | null;
    configFile: string | null;
    token: string | null;
    tunnel: string | null;
  };
}

export interface TunnelManagerOptions {
  config: TunnelConfig;
  logger: Logger;
}

function defaultTailscaleBin(configured: string | null): string {
  if (configured) {
    return configured;
  }
  return process.platform === "darwin"
    ? "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
    : "tailscale";
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

// Resolves the daemon's public webhook base URL and reports the tunnel status.
// It can optionally supervise the tunnel process (autoStart), but by default it
// only resolves the URL and assumes the tunnel is managed externally (systemd,
// the deploy script, or a manual `tailscale funnel` invocation).
export class TunnelManager {
  private readonly config: TunnelConfig;
  private readonly logger: Logger;
  private publicBaseUrl: string | null = null;
  private status: WebhookTunnelStatus = "disabled";
  private child: ChildProcess | null = null;
  private stopped = false;

  constructor(options: TunnelManagerOptions) {
    this.config = options.config;
    this.logger = options.logger.child({ module: "tunnel-manager" });
  }

  getProvider(): WebhookTunnelProvider {
    return this.config.provider;
  }

  getPublicBaseUrl(): string | null {
    return this.publicBaseUrl;
  }

  getStatus(): WebhookTunnelStatus {
    return this.status;
  }

  async start(): Promise<void> {
    this.stopped = false;
    // An explicit override always wins, regardless of provider.
    if (this.config.publicBaseUrl) {
      this.publicBaseUrl = stripTrailingSlash(this.config.publicBaseUrl);
    }

    switch (this.config.provider) {
      case "none":
        this.status = this.publicBaseUrl ? "running" : "disabled";
        return;
      case "tailscale-funnel":
        await this.startTailscaleFunnel();
        return;
      case "cloudflared":
        await this.startCloudflared();
        return;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }

  private async startTailscaleFunnel(): Promise<void> {
    const bin = defaultTailscaleBin(this.config.tailscaleBin);
    try {
      if (!this.publicBaseUrl) {
        const { stdout } = await execFileAsync(bin, ["status", "--json"], {
          maxBuffer: 10 * 1024 * 1024,
        });
        const parsed = JSON.parse(stdout) as { Self?: { DNSName?: string } };
        const dnsName = parsed.Self?.DNSName?.replace(/\.$/, "");
        if (dnsName) {
          this.publicBaseUrl = `https://${dnsName}`;
        }
      }
    } catch (error) {
      this.logger.warn({ err: error, bin }, "Failed to resolve Tailscale MagicDNS name");
    }

    if (this.config.autoStart) {
      try {
        // Persistent (--bg) funnel forwarding to the daemon's actual address
        // (which may be its Tailscale IP, not loopback). Non-hook paths are still
        // protected by the daemon's Host allowlist; only /hooks/* is exempt.
        await execFileAsync(bin, ["funnel", "--bg", `http://${this.config.localTarget}`]);
        this.status = "running";
      } catch (error) {
        this.logger.error({ err: error, bin }, "Failed to start Tailscale Funnel");
        this.status = "error";
        return;
      }
    } else {
      this.status = this.publicBaseUrl ? "running" : "error";
    }
  }

  private async startCloudflared(): Promise<void> {
    const cf = this.config.cloudflared;
    const isNamed = Boolean(cf.hostname || cf.token || cf.tunnel || cf.configFile);

    // Quick tunnel: no domain/account. Cloudflare assigns a random
    // *.trycloudflare.com URL that we parse from cloudflared's output. The URL
    // changes on every (re)start, so the daemon must run the process itself.
    if (!isNamed) {
      if (!this.config.autoStart) {
        this.logger.error("cloudflared quick tunnel requires autoStart");
        this.status = "error";
        return;
      }
      const bin = cf.bin ?? "cloudflared";
      this.spawnCloudflaredQuick(bin);
      return;
    }

    // Named tunnel: stable hostname owned by the user.
    if (!this.publicBaseUrl && cf.hostname) {
      const hostname = cf.hostname;
      this.publicBaseUrl = stripTrailingSlash(
        hostname.startsWith("http") ? hostname : `https://${hostname}`,
      );
    }
    if (!this.config.autoStart) {
      this.status = this.publicBaseUrl ? "running" : "error";
      return;
    }
    const bin = cf.bin ?? "cloudflared";
    const args = this.buildCloudflaredArgs();
    if (!args) {
      this.logger.error("cloudflared autoStart requires a token, config file, or tunnel name");
      this.status = "error";
      return;
    }
    this.spawnCloudflared(bin, args);
  }

  private spawnCloudflaredQuick(bin: string): void {
    const args = ["tunnel", "--no-autoupdate", "--url", `http://${this.config.localTarget}`];
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    this.status = "running";
    const onData = (buffer: Buffer) => {
      const match = buffer.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match && this.publicBaseUrl !== match[0]) {
        this.publicBaseUrl = match[0];
        this.logger.info({ url: match[0] }, "cloudflared quick tunnel URL assigned");
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (error) => {
      this.logger.error({ err: error, bin }, "cloudflared process error");
      this.status = "error";
    });
    child.on("exit", (code) => {
      this.child = null;
      // The old quick-tunnel URL is dead; clear it so the next run's URL is read.
      this.publicBaseUrl = null;
      if (this.stopped) {
        return;
      }
      this.logger.warn({ code }, "cloudflared quick tunnel exited; restarting in 5s");
      this.status = "error";
      setTimeout(() => {
        if (!this.stopped) {
          this.spawnCloudflaredQuick(bin);
        }
      }, 5000);
    });
  }

  private buildCloudflaredArgs(): string[] | null {
    const { token, configFile, tunnel } = this.config.cloudflared;
    if (token) {
      return ["tunnel", "run", "--token", token];
    }
    if (configFile) {
      return ["tunnel", "--config", configFile, "run"];
    }
    if (tunnel) {
      return ["tunnel", "run", tunnel];
    }
    return null;
  }

  private spawnCloudflared(bin: string, args: string[]): void {
    const child = spawn(bin, args, { stdio: "ignore" });
    this.child = child;
    this.status = "running";
    child.on("error", (error) => {
      this.logger.error({ err: error, bin }, "cloudflared process error");
      this.status = "error";
    });
    child.on("exit", (code) => {
      this.child = null;
      if (this.stopped) {
        return;
      }
      this.logger.warn({ code }, "cloudflared exited; will restart in 5s");
      this.status = "error";
      setTimeout(() => {
        if (!this.stopped) {
          this.spawnCloudflared(bin, args);
        }
      }, 5000);
    });
  }
}
