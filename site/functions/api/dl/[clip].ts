// Same-origin download proxy. Cross-origin <a download> from
// vtt-ui.pages.dev → pub-...r2.dev is ignored by Chrome (the file plays
// inline instead of downloading). Routing through this Pages Function
// gives us a same-origin URL that streams from R2 with
// `Content-Disposition: attachment` so the browser saves it.

interface Env {}

const PUBLIC_BASE = "https://pub-868d2bf7e2f6434c860d65dfe1cadad4.r2.dev";

const ID_RE = /^[A-Za-z0-9_-]+$/;

function safeFilename(raw: string): string {
  // Strip path separators + control chars; cap so we don't ship a
  // pathological Content-Disposition header.
  return raw.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim().slice(0, 80) || "clip";
}

export const onRequest: PagesFunction<Env> = async ({ params, request }) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", { status: 405 });
  }
  const raw = String(params.clip || "");
  const clipId = raw.replace(/\.mp4$/i, "");
  if (!ID_RE.test(clipId)) {
    return new Response("bad clip id", { status: 400 });
  }
  const url = new URL(request.url);
  const base = safeFilename(url.searchParams.get("n") || clipId);
  const filename = `${base}.mp4`;

  const upstream = await fetch(`${PUBLIC_BASE}/clips/${encodeURIComponent(clipId)}.mp4`);
  if (!upstream.ok) {
    return new Response(`upstream ${upstream.status}`, { status: upstream.status });
  }

  const headers = new Headers();
  headers.set("Content-Type", "video/mp4");
  const len = upstream.headers.get("content-length");
  if (len) headers.set("Content-Length", len);
  // RFC 6266 — quoted filename + UTF-8 fallback for non-ASCII.
  headers.set(
    "Content-Disposition",
    `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  headers.set("Cache-Control", "public, max-age=86400");

  return new Response(upstream.body, { status: 200, headers });
};
