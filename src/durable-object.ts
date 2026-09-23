import { DurableObject } from "cloudflare:workers";
import * as api from "./api";
import { COMPONENTS } from "./components.config";
import * as auth from "./auth";
import * as db from "./db";
import * as ingest from "./ingest";
import type { Config, Env } from "./types";

export class HangtimeDO extends DurableObject<Env> {
  private tokenPromise: Promise<string> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      db.initSchema(ctx.storage.sql);
    });
  }

  private config(): Config {
    return {
      targetDegreeDays: Number(this.env.TARGET_DEGREE_DAYS ?? 40),
      maxGapMinutes: Number(this.env.MAX_GAP_MINUTES ?? 240),
    };
  }

  private token(): Promise<string> {
    if (!this.tokenPromise) this.tokenPromise = auth.computeToken(this.env.APP_PASSWORD);
    return this.tokenPromise;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws") return this.handleWsUpgrade(request);
    const token = await this.token();
    return api.route(request, this.ctx.storage.sql, this.env, token, this.config());
  }

  private handleWsUpgrade(request: Request): Response {
    const url = new URL(request.url);
    const token = url.searchParams.get("token") ?? request.headers.get("X-Gateway-Token");
    if (token !== this.env.GATEWAY_TOKEN) {
      return new Response("unauthorized", { status: 401 });
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ["gateway"]);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return; // gateway only sends JSON text frames
    let msg: unknown;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    ingest.handleRpc(msg as Parameters<typeof ingest.handleRpc>[0], COMPONENTS, (loc, kind, value, ts) =>
      ingest.handle(this.ctx.storage.sql, loc, kind, value, ts),
    );
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
  }

  async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
    // No in-memory cleanup needed — all state lives in ctx.storage.sql.
  }
}
