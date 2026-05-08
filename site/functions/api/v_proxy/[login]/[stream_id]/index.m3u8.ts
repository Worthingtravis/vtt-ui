/**
 * /api/v_proxy/<login>/<stream_id>/index.m3u8
 *
 * Thin proxy that resolves a fresh vodvod.top m3u8 URL (their tokens
 * rotate) and rewrites the CloudFront segment URLs to point at our
 * `/api/v_proxy/seg` opaque proxy. Result: a single-rendition HLS
 * playlist that's CORS-safe for `<video>` / hls.js playback from
 * vtt-ui.pages.dev.
 *
 * See `project_storage_tiering_proposal.md` and
 * `project_vodvod_cors_audio_only.md` for context. The m3u8 served by
 * vodvod.top has `Access-Control-Allow-Origin: https://vodvod.top` and
 * the CloudFront segments have no CORS headers at all — so a direct
 * `<video src=https://api.vodvod.top/...>` won't play in Chrome/Firefox.
 *
 * `?t=NN` is preserved in the response (browsers honor it on the
 * `<video>` element separately, but consistently echoing makes the URL
 * easy to share).
 */

interface Env {}

const VODVOD_API = "https://api.vodvod.top";
const SEG_TTL_SECONDS = 86_400; // CloudFront chunks are immutable
const M3U8_TTL_SECONDS = 30;    // m3u8 token rotates; refetch quickly

interface VodvodEntry {
  stream_id?: string;
  m3u8_url?: string;
  title?: string;
  name?: string;
}

async function listChannelVods(login: string): Promise<VodvodEntry[]> {
  const safe = login.replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase();
  const r = await fetch(`${VODVOD_API}/channels/@${safe}`, {
    headers: { "user-agent": "vtt-ui-v_proxy/1.0" },
    cf: { cacheTtl: 60, cacheEverything: true } as RequestInitCfProperties,
  });
  if (!r.ok) throw new Error(`vodvod listing failed for ${login}: ${r.status}`);
  const data = await r.json() as VodvodEntry[] | { videos?: VodvodEntry[] };
  return Array.isArray(data) ? data : (data.videos ?? []);
}

function rewriteSegments(m3u8Body: string, segProxyBase: string): string {
  // CloudFront segment URLs are absolute (https://d2nvs31859zcd8.cloudfront.net/...).
  // We rewrite each absolute segment URL to point at /api/v_proxy/seg?u=<encoded>.
  return m3u8Body.replace(
    /^(https?:\/\/[^\s]+\.ts)\s*$/gm,
    (full, url) => `${segProxyBase}?u=${encodeURIComponent(url)}`,
  );
}

export const onRequest: PagesFunction<Env> = async ({ params, request }) => {
  const login = String(params.login || "").trim();
  const streamId = String(params.stream_id || "").trim();
  if (!login || !streamId) {
    return new Response("login + stream_id required", { status: 400 });
  }

  let entries: VodvodEntry[];
  try {
    entries = await listChannelVods(login);
  } catch (e: unknown) {
    return new Response(`upstream listing error: ${(e as Error).message}`, {
      status: 502,
      headers: { "access-control-allow-origin": "*" },
    });
  }

  const match = entries.find((v) => String(v.stream_id ?? "") === streamId);
  if (!match || !match.m3u8_url) {
    return new Response(`stream_id ${streamId} not in listing for ${login}`, {
      status: 404,
      headers: { "access-control-allow-origin": "*" },
    });
  }

  const upstream = await fetch(match.m3u8_url, {
    headers: { "user-agent": "vtt-ui-v_proxy/1.0" },
  });
  if (!upstream.ok) {
    return new Response(`upstream m3u8 ${upstream.status}`, {
      status: 502,
      headers: { "access-control-allow-origin": "*" },
    });
  }
  const body = await upstream.text();

  const origin = new URL(request.url).origin;
  const segBase = `${origin}/api/v_proxy/seg`;
  const rewritten = rewriteSegments(body, segBase);

  return new Response(rewritten, {
    status: 200,
    headers: {
      "content-type": "application/x-mpegURL",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
      "cache-control": `public, max-age=${M3U8_TTL_SECONDS}`,
      "x-vtt-vproxy": "m3u8",
    },
  });
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
