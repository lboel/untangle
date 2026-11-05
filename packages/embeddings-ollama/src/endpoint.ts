/**
 * Endpoint redaction helper (spec.md §3.2 "Health-Ausgaben MÜSSEN die
 * tatsächlich verwendeten Endpunkte anzeigen, wobei Secrets redigiert
 * werden").
 *
 * `@untangle-code/observability`'s `redact()` redacts object fields by key
 * name; it has no notion of a URL's own embedded-credentials syntax
 * (`https://user:pass@host/...`). This is the narrow, URL-specific
 * complement: it never touches the bearer token sent via the
 * `Authorization` header (that never becomes part of the URL to begin
 * with) — it only strips userinfo that a misconfigured `url` might carry.
 */
export function redactEndpointUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
      return url.toString();
    }
    return rawUrl;
  } catch {
    // Not a parseable absolute URL — nothing structured to redact.
    return rawUrl;
  }
}

/** Joins a base endpoint URL with a request path, tolerating a trailing slash on the base. */
export function joinUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}
