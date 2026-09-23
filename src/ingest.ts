import * as db from "./db";
import type { ComponentMap, Location, RpcMessage } from "./types";

function isLocation(v: unknown): v is Location {
  return v === "ute" || v === "inne";
}

// Port of ingest.rb#handle_rpc — dispatches one already-parsed JSON-RPC message
// (one per WebSocket text frame, unlike the UDP transport which needed line-splitting).
export function handleRpc(
  msg: RpcMessage,
  components: ComponentMap,
  onHandle: (location: Location, kind: "temperature" | "humidity" | "button", value: number | string, ts: number | null) => void,
): void {
  if (msg.method === "NotifyStatus") {
    const params = msg.params ?? {};
    for (const [comp, val] of Object.entries(params)) {
      if (comp === "ts") continue;
      const map = components[comp];
      if (!map || (map.kind !== "temperature" && map.kind !== "humidity")) continue;
      if (typeof val !== "object" || val === null || typeof (val as Record<string, unknown>).value !== "number") continue;
      const ts = typeof params.ts === "number" ? params.ts : null;
      onHandle(map.location, map.kind, (val as Record<string, unknown>).value as number, ts);
    }
  } else if (msg.method === "NotifyEvent") {
    const events = (msg.params?.events as Array<Record<string, unknown>> | undefined) ?? [];
    for (const ev of events) {
      const ts = typeof ev.ts === "number" ? ev.ts : null;

      // shelly/ble-hangtime-relay.js: a Shelly-script-emitted event carrying its own
      // location and already-decoded BTHome fields (no per-gateway component-id map needed).
      // Shelly.emitEvent() nests the passed data object under `data`, not spread onto ev.
      if (ev.event === "bthome_report") {
        const data = (ev.data ?? {}) as Record<string, unknown>;
        if (isLocation(data.location)) {
          if (typeof data.temperature === "number") onHandle(data.location, "temperature", data.temperature, ts);
          if (typeof data.humidity === "number") onHandle(data.location, "humidity", data.humidity, ts);
          if (typeof data.button === "number") onHandle(data.location, "button", "push", ts);
        }
        continue;
      }

      // Legacy path: a native Shelly BLU Gateway relaying its own bthomesensor:N components.
      const map = components[ev.component as string];
      if (!map || map.kind !== "button" || !String(ev.event).includes("push")) continue;
      onHandle(map.location, "button", String(ev.event), ts);
    }
  }
}

// Port of ingest.rb#handle. Debounce state lives in the `last_button` table (see db.ts)
// instead of an in-memory hash, since the Durable Object may hibernate between messages.
export function handle(
  sql: SqlStorage,
  location: Location,
  kind: "temperature" | "humidity" | "button",
  value: number | string,
  ts: number | null,
): void {
  if (!isLocation(location)) return;
  const t = ts != null ? Math.trunc(ts) : db.now();

  if (kind === "temperature") {
    db.addReading(sql, location, Number(value), t);
  } else if (kind === "humidity") {
    db.addHumidity(sql, location, Number(value), t);
  } else if (kind === "button") {
    const last = db.getLastButton(sql, location);
    if (last != null && t - last < 3) return; // debounce double-press
    db.setLastButton(sql, location, t);
    if (location === "ute") {
      db.createMoose(sql, t);
    } else {
      const mo = db.oldestOutside(sql);
      if (mo) {
        db.moveInside(sql, mo.id, t);
      } else {
        db.logEvent(sql, "kyl_tryck_utan_alg", "inne", null, t);
      }
    }
  }
}
