/**
 * /api/v_proxy/seg?u=<encoded CDN URL>
 *
 * Opaque proxy for CloudFront video segments. The m3u8 emitted by
 * `/api/v_proxy/<login>/<stream_id>/index.m3u8` rewrites every absolute
 * segment URL to flow through here so the browser sees a same-origin
 * resource and `Access-Control-Allow-Origin: *` survives.
 *
 * Allowed upstream hosts are restricted to known Twitch / vodvod CDNs
 * to prevent the proxy from being weaponized as an open relay.
 *
 * Range requests are forwarded so hls.js + native `<video>` can scrub.
 * Responses are cached at the Cloudflare edge for 24h (segments are
 * immutable: their URLs include the broadcast id + chunk index).
 */

interface Env {}

const ALLOWED_HOSTS = new Set<string>([
  "d2nvs31859zcd8.cloudfront.net",
  "api.vodvod.top",
  "vodvod.top",
]);

const SEG_TTL_SECONDS = 86_400; // immutable chunks

function corsHeaders(extra: Record<string, string> = {}): HeadersInit {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-expose-headers":
      "Content-Length, Content-Range, Accept-Ranges, Content-Type",
    "cache-control": `public, max-age=${SEG_TTL_SECONDS}, immutable`,
    "x-vtt-vproxy": "seg",
    ...extra,
  };
}

export const onRequest: PagesFunction<Env> = async ({ request }) => {
  const url = new URL(request.url);
  const target = url.searchParams.get("u");
  if (!target) {
    return new Response("missing u param", { status: 400, headers: corsHeaders() });
  }

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return new Response("u must be an absolute URL", { status: 400, headers: corsHeaders() });
  }
  if (!ALLOWED_HOSTS.has(parsed.host)) {
    return new Response(`upstream host not allowed: ${parsed.host}`, {
      status: 403,
      headers: corsHeaders(),
    });
  }

  // Try the Cloudflare cache first — CDN segments are immutable per (broadcast, chunk).
  const cache = (caches as unknown as { default: Cache }).default;
  const cacheKey = new Request(`https://v_proxy/${target}`, { method: "GET" });
  let cached = await cache.match(cacheKey);
  if (cached) {
    // Surface CORS on the cached response.
    return new Response(cached.body, {
      status: cached.status,
      headers: { ...Object.fromEntries(cached.headers), ...corsHeaders() },
    });
  }

  const upstreamHeaders = new Headers();
  const range = request.headers.get("range");
  if (range) upstreamHeaders.set("range", range);
  upstreamHeaders.set("user-agent", "vtt-ui-v_proxy/1.0");

  const upstream = await fetch(parsed.toString(), {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    headers: upstreamHeaders,
  });

  // Forward useful headers, override CORS + caching.
  const passthrough = new Headers();
  for (const h of ["content-type", "content-length", "content-range",
                    "accept-ranges", "etag", "last-modified"]) {
    const v = upstream.headers.get(h);
    if (v) passthrough.set(h, v);
  }
  for (const [k, v] of Object.entries(corsHeaders())) {
    passthrough.set(k, String(v));
  }

  // 200 / 206 are cacheable; anything else (302, 404) we just pass through.
  const resp = new Response(upstream.body, {
    status: upstream.status,
    headers: passthrough,
  });

  if ((upstream.status === 200 || upstream.status === 206) && request.method === "GET") {
    // Tee — clone for the cache, return the original.
    try {
      // Note: ctx.waitUntil isn't available here without restructuring;
      // a fire-and-forget cache write is fine. If it fails, next request reproxies.
      await cache.put(cacheKey, resp.clone());
    } catch {
      // ignore cache errors
    }
  }
  return resp;
};

export const onRequestOptions: PagesFunction<Env> = () =>
  new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
      "access-control-allow-headers": "Range, If-None-Match, Cache-Control",
      "access-control-max-age": "86400",
    },
  });
