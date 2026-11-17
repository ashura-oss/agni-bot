/**
 * Whether this machine can listen on the IPv6 loopback address (`::1`). A host with IPv6 switched off (some containers,
 * some CI images) cannot, and a test that needs `::1` is then skipped, not failed: `test.skipIf(!IPV6_LOOPBACK)`.
 */
type Listener = { stop(force?: boolean): unknown };
type Serve = (options: { hostname: string; port: number; fetch: () => Response }) => Listener;

export function ipv6LoopbackAvailable(serve: Serve = Bun.serve as unknown as Serve): boolean {
  try {
    serve({ hostname: "::1", port: 0, fetch: () => new Response("") }).stop(true);
    return true;
  } catch {
    return false;
  }
}

/** Probed once, when a test file imports this. */
export const IPV6_LOOPBACK = ipv6LoopbackAvailable();
