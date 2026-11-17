import { assertPublicHost, resolvePublicHost } from "../../../apps/server/src/tools/fetch-url";

export async function positive(userUrl: string, base: string): Promise<void> {
  // ruleid: agni-fetch-without-ssrf-guard
  await fetch(userUrl);
  // ruleid: agni-fetch-without-ssrf-guard
  await fetch(`${base}/v1/search`, { method: "POST" });
}

export async function positiveGuardComesAfter(userUrl: string): Promise<void> {
  // ruleid: agni-fetch-without-ssrf-guard
  const response = await fetch(userUrl);
  await assertPublicHost(new URL(userUrl).hostname);
  void response;
}

/** A check on some other value says nothing about the URL that is fetched. */
export async function positiveGuardOnAnotherValue(userUrl: string, otherUrl: string): Promise<void> {
  await assertPublicHost(new URL(otherUrl).hostname);
  // ruleid: agni-fetch-without-ssrf-guard
  await fetch(userUrl);
}

export async function positiveGuardOnAnotherUrlObject(raw: string, other: string): Promise<void> {
  const url = new URL(raw);
  const checked = new URL(other);
  await resolvePublicHost(checked.hostname);
  // ruleid: agni-fetch-without-ssrf-guard
  await fetch(url, { redirect: "manual" });
}

export async function negativeGuarded(userUrl: string): Promise<void> {
  await assertPublicHost(new URL(userUrl).hostname);
  // ok: agni-fetch-without-ssrf-guard
  await fetch(userUrl, { redirect: "manual" });
}

export async function negativeResolved(userUrl: string): Promise<void> {
  const addresses = await resolvePublicHost(new URL(userUrl).hostname);
  void addresses;
  // ok: agni-fetch-without-ssrf-guard
  await fetch(userUrl, { redirect: "manual" });
}

export async function negativeGuardedUrlObject(raw: string): Promise<void> {
  const url = new URL(raw);
  const addresses = await resolvePublicHost(url.hostname);
  void addresses;
  // ok: agni-fetch-without-ssrf-guard
  await fetch(url, { redirect: "manual" });
}

export async function negativeLiteral(): Promise<void> {
  // ok: agni-fetch-without-ssrf-guard
  await fetch("https://api.example.com/v1/status");
}
