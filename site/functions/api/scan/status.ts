/**
 * GET /api/scan/status?job_id=<id>
 *
 * Public passthrough to serve.py's /api/jobs/<id>. Used by the
 * "kick off a scan" button polling — no auth required because the
 * caller already knows the job_id (returned by /api/scan/queue, which
 * is auth-gated). Job status itself is non-sensitive: state +
 * progress.stage + progress.msg.
 */
const PUBLIC_R2 = "https://pub-868d2bf7e2f6434c860d65dfe1cadad4.r2.dev";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function getRenderApi(): Promise<string | null> {
  try {
    const r = await fetch(`${PUBLIC_R2}/config.json`, { cf: { cacheTtl: 60 } } as RequestInit);
    if (!r.ok) return null;
    const d = (await r.json()) as { render_api_base?: string };
    return d.render_api_base || null;
  } catch {
    return null;
  }
}

export const onRequestGet: PagesFunction = async ({ request }) => {
  const url = new URL(request.url);
  const jobId = (url.searchParams.get("job_id") || "").trim();
  if (!jobId || !/^[\w-]+$/.test(jobId)) {
    return json({ ok: false, error: "job_id required" }, 400);
  }
  const renderApi = await getRenderApi();
  if (!renderApi) {
    return json({ ok: false, error: "render api unavailable" }, 502);
  }
  const upstream = await fetch(
    `${renderApi}/api/jobs/${encodeURIComponent(jobId)}`,
    { method: "GET" },
  );
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") || "application/json",
      "cache-control": "no-store",
    },
  });
};
