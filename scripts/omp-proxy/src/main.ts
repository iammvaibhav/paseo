// One binary with two modes, so a host stores the Bun runtime only once:
//   omp-proxy                  HTTP proxy (server.ts)
//   omp-proxy grok-refresher   grok-build token refresher (grok-refresher.ts),
//                              for the auth broker host only
// Dynamic imports: each module starts work at load, so load only the selected mode.
if (process.argv[2] === "grok-refresher") {
	await import("./grok-refresher");
} else {
	await import("./server");
}

export {};
