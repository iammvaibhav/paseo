import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, test } from "vitest";
import { createItsaplanWebhookUrl } from "./webhook-url.js";

function ipv4(address: string, internal = false): NetworkInterfaceInfo {
  return { address, family: "IPv4", internal, netmask: "", mac: "", cidr: null };
}

const DEV_INTERFACES = {
  lo: [ipv4("127.0.0.1", true)],
  enp0s6: [ipv4("10.0.0.237")],
  wt0: [ipv4("100.123.178.38")],
};

describe("createItsaplanWebhookUrl", () => {
  test("a wildcard-bound daemon registers its fleet overlay address, not loopback", () => {
    // itsaplan runs on another host: 127.0.0.1 there is that host's own daemon.
    expect(
      createItsaplanWebhookUrl({ type: "tcp", host: "0.0.0.0", port: 6767 }, DEV_INTERFACES),
    ).toBe("http://100.123.178.38:6767/api/itsaplan/webhook");
  });

  test("an explicit bind address is used as is", () => {
    expect(
      createItsaplanWebhookUrl({ type: "tcp", host: "100.123.97.105", port: 6767 }, DEV_INTERFACES),
    ).toBe("http://100.123.97.105:6767/api/itsaplan/webhook");
  });

  test("keeps loopback when the host has no overlay address", () => {
    expect(
      createItsaplanWebhookUrl(
        { type: "tcp", host: "0.0.0.0", port: 6767 },
        { lo: [ipv4("127.0.0.1", true)], eth0: [ipv4("192.168.1.5")] },
      ),
    ).toBe("http://127.0.0.1:6767/api/itsaplan/webhook");
  });

  test("a socket-bound daemon has no webhook URL", () => {
    expect(createItsaplanWebhookUrl({ type: "socket", path: "/tmp/p.sock" }, DEV_INTERFACES)).toBe(
      null,
    );
  });
});
