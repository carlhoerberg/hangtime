import * as auth from "./auth";
import * as db from "./db";
import type { Config, Env } from "./types";

function json(obj: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(obj), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

async function bodyJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function idFromPath(pathname: string, prefix: string): number {
  return parseInt(pathname.slice(prefix.length), 10);
}

export async function route(request: Request, sql: SqlStorage, env: Env, token: string, cfg: Config): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/login" && method === "POST") {
    const body = await bodyJson(request);
    if (body.password === env.APP_PASSWORD) {
      return json(
        { ok: true },
        { headers: { "Set-Cookie": auth.setAuthCookie(token, auth.isHttps(request)) } },
      );
    }
    return json({ error: "Fel lösenord" }, { status: 401 });
  }

  if (path === "/api/logout" && method === "POST") {
    return json({ ok: true }, { headers: { "Set-Cookie": auth.clearAuthCookie() } });
  }

  if (!auth.isAuthed(request, token)) {
    return json({ error: "Logga in" }, { status: 401 });
  }

  if (path === "/api/state" && method === "GET") {
    const moose = db.listMoose(sql).map((m) => db.mooseView(sql, m, cfg));
    return json({
      target: cfg.targetDegreeDays,
      temps: { ute: db.latestTemp(sql, "ute"), inne: db.latestTemp(sql, "inne") },
      humidity: { ute: db.latestHumidity(sql, "ute"), inne: db.latestHumidity(sql, "inne") },
      moose,
      events: db.recentEvents(sql, 20),
    });
  }

  if (path === "/api/history" && method === "GET") {
    const hours = Math.min(Math.max(parseInt(url.searchParams.get("hours") ?? "168", 10) || 168, 1), 24 * 90);
    const bucket = hours <= 48 ? 600 : hours <= 24 * 14 ? 1800 : 7200;
    const from = db.now() - hours * 3600;
    return json({ from, bucket, series: db.history(sql, from, bucket) });
  }

  if (path === "/api/moose" && method === "POST") {
    return json(db.createMoose(sql));
  }

  if (path.startsWith("/api/moose/") && path.endsWith("/inside") && method === "POST") {
    const id = idFromPath(path, "/api/moose/");
    return json(db.moveInside(sql, id));
  }

  if (path.startsWith("/api/moose/") && path.endsWith("/done") && method === "POST") {
    const id = idFromPath(path, "/api/moose/");
    return json(db.updateMoose(sql, id, { done_at: db.now() }));
  }

  if (path.startsWith("/api/moose/") && method === "PATCH") {
    const id = idFromPath(path, "/api/moose/");
    const body = await bodyJson(request);
    const fields: Record<string, unknown> = {};
    for (const k of ["name", "comment", "weight_kg", "out_start", "in_start", "done_at"]) {
      if (k in body) fields[k] = body[k];
    }
    return json(db.updateMoose(sql, id, fields));
  }

  if (path.startsWith("/api/moose/") && method === "DELETE") {
    const id = idFromPath(path, "/api/moose/");
    db.deleteMoose(sql, id);
    return json({ ok: true });
  }

  if (path === "/api/reading" && method === "POST") {
    const body = await bodyJson(request);
    const loc = body.location;
    const temp = body.temp;
    if ((loc !== "ute" && loc !== "inne") || typeof temp !== "number") {
      return json({ error: "location + temp krävs" }, { status: 400 });
    }
    db.addReading(sql, loc, temp);
    return json({ ok: true });
  }

  return json({ error: "not found" }, { status: 404 });
}
