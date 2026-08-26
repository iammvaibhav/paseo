import { describe, expect, it } from "vitest";
import type { HostProfile } from "@/types/host-connection";
import {
  ITSAPLAN_DEFAULT_PORT,
  isLoopbackHostname,
  normalizeItsaplanOrigin,
  resolveItsaplanEmbedOrigin,
} from "./itsaplan-origin";

describe("normalizeItsaplanOrigin", () => {
  it("returns null for empty or whitespace-only values", () => {
    expect(normalizeItsaplanOrigin(null)).toBeNull();
    expect(normalizeItsaplanOrigin(undefined)).toBeNull();
    expect(normalizeItsaplanOrigin("")).toBeNull();
    expect(normalizeItsaplanOrigin("   ")).toBeNull();
  });

  it("assumes https when the scheme is omitted", () => {
    expect(normalizeItsaplanOrigin("10.7.0.1:8443")).toBe("https://10.7.0.1:8443");
    expect(normalizeItsaplanOrigin("iammvaibhav")).toBe("https://iammvaibhav");
  });

  it("keeps an explicit scheme and strips paths", () => {
    expect(normalizeItsaplanOrigin("http://10.0.0.237:3001")).toBe("http://10.0.0.237:3001");
    expect(normalizeItsaplanOrigin("https://host.example:8443/tickets?x=1")).toBe(
      "https://host.example:8443",
    );
  });

  it("rejects non-http schemes and unparseable values", () => {
    expect(normalizeItsaplanOrigin("javascript:alert(1)")).toBeNull();
    expect(normalizeItsaplanOrigin("ftp://host:21")).toBeNull();
    expect(normalizeItsaplanOrigin("https://[::1:not-a-port")).toBeNull();
  });
});

describe("isLoopbackHostname", () => {
  it("recognizes loopback spellings including bracketed ipv6", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname("api.localhost")).toBe(true);
    expect(isLoopbackHostname("iammvaibhav")).toBe(false);
    expect(isLoopbackHostname("10.7.0.1")).toBe(false);
  });
});

describe("resolveItsaplanEmbedOrigin", () => {
  const hostProfile = {
    serverId: "s1",
    label: "dev box",
    appearance: { color: "none", badgeDisplay: null },
    lifecycle: {},
    browserEditorUrl: "http://dev-box:8765",
    connections: [],
    preferredConnectionId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } satisfies HostProfile;

  it("derives https on the default port for a local daemon", () => {
    expect(resolveItsaplanEmbedOrigin({ isLocalDaemon: true })).toEqual({
      origin: `https://localhost:${ITSAPLAN_DEFAULT_PORT}`,
      source: "derived",
    });
  });

  it("derives the origin from the host profile for a remote daemon", () => {
    expect(resolveItsaplanEmbedOrigin({ isLocalDaemon: false, hostProfile })).toEqual({
      origin: `https://dev-box:${ITSAPLAN_DEFAULT_PORT}`,
      source: "derived",
    });
  });

  it("returns null for a remote daemon with no resolvable embed host", () => {
    expect(resolveItsaplanEmbedOrigin({ isLocalDaemon: false })).toBeNull();
  });

  it("prefers a configured override as-is", () => {
    expect(
      resolveItsaplanEmbedOrigin({
        isLocalDaemon: false,
        configuredOrigin: "http://10.7.0.1:8443",
        hostProfile,
      }),
    ).toEqual({ origin: "http://10.7.0.1:8443", source: "override" });
  });

  it("rewrites a loopback override to the remote embed hostname, keeping scheme and port", () => {
    expect(
      resolveItsaplanEmbedOrigin({
        isLocalDaemon: false,
        configuredOrigin: "https://localhost:8443",
        hostProfile,
      }),
    ).toEqual({ origin: "https://dev-box:8443", source: "override" });
  });

  it("does not rewrite a loopback override for a local daemon", () => {
    expect(
      resolveItsaplanEmbedOrigin({
        isLocalDaemon: true,
        configuredOrigin: "https://localhost:9000",
      }),
    ).toEqual({ origin: "https://localhost:9000", source: "override" });
  });

  it("falls back to derivation when the override does not parse", () => {
    expect(
      resolveItsaplanEmbedOrigin({
        isLocalDaemon: false,
        configuredOrigin: "not a url",
        hostProfile,
      }),
    ).toEqual({
      origin: `https://dev-box:${ITSAPLAN_DEFAULT_PORT}`,
      source: "derived",
    });
  });
});
