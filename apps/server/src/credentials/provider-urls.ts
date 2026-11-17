/**
 * A custom provider's address can carry a credential: `https://user:key@host/v1`
 * or `https://host/v1?api_key=...`. In vault mode the full address lives in the
 * vault (`provider-url/<provider id>`) and `providers.json` keeps a clean one,
 * the same address with the credential taken out.
 */
import { valueCarriesCredential } from "../secrets/classify";

/** The address without its user name, password and credential-looking query parameters. */
export function sanitizeBaseUrl(raw: string): string {
  const url = new URL(raw.trim());
  url.username = "";
  url.password = "";
  for (const key of [...new Set(url.searchParams.keys())]) {
    // The classifier decides what looks like a credential; ask it about this one parameter.
    if (valueCarriesCredential(`https://x.invalid/?${encodeURIComponent(key)}=1`)) url.searchParams.delete(key);
  }
  return url.toString().replace(/\/+$/, "");
}

/** True when the address needs the vault: it carries a user name, a password or a credential parameter. */
export function baseUrlCarriesCredential(raw: string): boolean {
  return valueCarriesCredential(raw);
}
