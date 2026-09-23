import type { Config, EventRow, Humidity, Location, Moose, MooseView, Reading } from "./types";

const LOCATIONS: Location[] = ["ute", "inne"];

export function initSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS moose (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      out_start  INTEGER,
      in_start   INTEGER,
      done_at    INTEGER,
      weight_kg  REAL,
      comment    TEXT DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS readings (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      location TEXT NOT NULL,
      ts       INTEGER NOT NULL,
      temp     REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS readings_loc_ts ON readings(location, ts);
    CREATE TABLE IF NOT EXISTS humidity (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      location TEXT NOT NULL,
      ts       INTEGER NOT NULL,
      rh       REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS humidity_loc_ts ON humidity(location, ts);
    CREATE TABLE IF NOT EXISTS events (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      ts       INTEGER NOT NULL,
      location TEXT,
      type     TEXT NOT NULL,
      moose_id INTEGER,
      note     TEXT
    );
    -- Replaces ingest.rb's in-memory @last_button hash, which would not survive DO hibernation.
    CREATE TABLE IF NOT EXISTS last_button (location TEXT PRIMARY KEY, ts INTEGER NOT NULL);
  `);
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

function rows<T>(cursor: SqlStorageCursor<Record<string, SqlStorageValue>>): T[] {
  return [...cursor] as unknown as T[];
}

function row<T>(cursor: SqlStorageCursor<Record<string, SqlStorageValue>>): T | null {
  const all = rows<T>(cursor);
  return all.length ? all[0] : null;
}

// ---------- Readings ----------
export function addReading(sql: SqlStorage, location: Location, temp: number, ts = now()): void {
  sql.exec("INSERT INTO readings (location, ts, temp) VALUES (?, ?, ?)", location, ts, temp);
}

export function latestTemp(sql: SqlStorage, location: Location): { ts: number; temp: number } | null {
  return row(sql.exec("SELECT ts, temp FROM readings WHERE location=? ORDER BY ts DESC LIMIT 1", location));
}

export function addHumidity(sql: SqlStorage, location: Location, rh: number, ts = now()): void {
  sql.exec("INSERT INTO humidity (location, ts, rh) VALUES (?, ?, ?)", location, ts, rh);
}

export function latestHumidity(sql: SqlStorage, location: Location): { ts: number; rh: number } | null {
  return row(sql.exec("SELECT ts, rh FROM humidity WHERE location=? ORDER BY ts DESC LIMIT 1", location));
}

// Same bucketed-series shape as db.rb#history: one averaged value per `bucket`-second slot.
export function history(sql: SqlStorage, from: number, bucket: number) {
  const series: { temp: Record<string, [number, number][]>; rh: Record<string, [number, number][]> } = {
    temp: {},
    rh: {},
  };
  for (const loc of LOCATIONS) {
    series.temp[loc] = rows<{ t: number; v: number }>(
      sql.exec(
        "SELECT (ts - ?) / ? * ? + ? AS t, AVG(temp) v FROM readings WHERE location=? AND ts >= ? GROUP BY t ORDER BY t",
        from,
        bucket,
        bucket,
        from,
        loc,
        from,
      ),
    ).map((r) => [r.t, Math.round(r.v * 10) / 10] as [number, number]);
    series.rh[loc] = rows<{ t: number; v: number }>(
      sql.exec(
        "SELECT (ts - ?) / ? * ? + ? AS t, AVG(rh) v FROM humidity WHERE location=? AND ts >= ? GROUP BY t ORDER BY t",
        from,
        bucket,
        bucket,
        from,
        loc,
        from,
      ),
    ).map((r) => [r.t, Math.round(r.v)] as [number, number]);
  }
  return series;
}

// ---------- Degree-days ----------
// Step-integration: each reading holds forward to the next, capped at max_gap seconds.
// Sub-zero temperatures don't contribute.
export function degreeDays(sql: SqlStorage, location: Location, from: number | null, to: number, maxGap: number): number {
  if (from == null || to <= from) return 0.0;
  const readings = rows<{ ts: number; temp: number }>(
    sql.exec(
      `SELECT ts, temp FROM readings
       WHERE location=? AND ts >= COALESCE((SELECT MAX(ts) FROM readings WHERE location=? AND ts <= ?), 0) AND ts <= ?
       ORDER BY ts ASC`,
      location,
      location,
      from,
      to,
    ),
  );
  if (readings.length === 0) return 0.0;
  let sum = 0;
  for (let i = 0; i < readings.length; i++) {
    const start = Math.max(readings[i].ts, from);
    let fin = i + 1 < readings.length ? readings[i + 1].ts : to;
    fin = Math.min(fin, to, start + maxGap);
    if (fin > start) sum += Math.max(readings[i].temp, 0) * (fin - start) / 86_400.0;
  }
  return sum;
}

// ---------- Moose ----------
export function listMoose(sql: SqlStorage): Moose[] {
  return rows<Moose>(sql.exec("SELECT * FROM moose ORDER BY created_at ASC"));
}

export function getMoose(sql: SqlStorage, id: number): Moose | null {
  return row<Moose>(sql.exec("SELECT * FROM moose WHERE id=?", id));
}

export function createMoose(sql: SqlStorage, ts = now()): Moose {
  // strftime(..., 'unixepoch') is UTC in SQLite, matching Ruby's use of the same modifier —
  // so the "Älg N · YEAR" counter rolls over at UTC midnight on New Year's, not local time.
  const year = new Date(ts * 1000).getUTCFullYear();
  const count = row<{ c: number }>(
    sql.exec("SELECT COUNT(*) c FROM moose WHERE strftime('%Y', created_at, 'unixepoch') = ?", String(year)),
  )!.c;
  const name = `Älg ${count + 1} · ${year}`;
  const inserted = row<{ id: number }>(
    sql.exec("INSERT INTO moose (name, out_start, created_at) VALUES (?, ?, ?) RETURNING id", name, ts, ts),
  )!;
  logEvent(sql, "ny_alg", "ute", inserted.id, ts);
  return getMoose(sql, inserted.id)!;
}

export function oldestOutside(sql: SqlStorage): Moose | null {
  return row<Moose>(
    sql.exec("SELECT * FROM moose WHERE in_start IS NULL AND done_at IS NULL ORDER BY out_start ASC LIMIT 1"),
  );
}

export function moveInside(sql: SqlStorage, id: number, ts = now()): Moose | null {
  sql.exec("UPDATE moose SET in_start=? WHERE id=?", ts, id);
  logEvent(sql, "in_i_kyl", "inne", id, ts);
  return getMoose(sql, id);
}

const ALLOWED_FIELDS = ["name", "out_start", "in_start", "done_at", "weight_kg", "comment"] as const;
type AllowedField = (typeof ALLOWED_FIELDS)[number];

export function updateMoose(sql: SqlStorage, id: number, fields: Partial<Record<AllowedField, unknown>>): Moose | null {
  const entries = Object.entries(fields).filter(([k]) => (ALLOWED_FIELDS as readonly string[]).includes(k));
  if (entries.length === 0) return getMoose(sql, id);
  const setClause = entries.map(([k]) => `${k}=?`).join(", ");
  sql.exec(`UPDATE moose SET ${setClause} WHERE id=?`, ...entries.map(([, v]) => v as SqlStorageValue), id);
  return getMoose(sql, id);
}

export function deleteMoose(sql: SqlStorage, id: number): void {
  sql.exec("DELETE FROM moose WHERE id=?", id);
}

// ---------- Events ----------
export function logEvent(sql: SqlStorage, type: string, location: Location | null, mooseId: number | null, ts = now(), note: string | null = null): void {
  sql.exec("INSERT INTO events (ts, location, type, moose_id, note) VALUES (?, ?, ?, ?, ?)", ts, location, type, mooseId, note);
}

export function recentEvents(sql: SqlStorage, n = 20): EventRow[] {
  return rows<EventRow>(
    sql.exec("SELECT e.*, m.name FROM events e LEFT JOIN moose m ON m.id=e.moose_id ORDER BY e.ts DESC LIMIT ?", n),
  );
}

// ---------- Last-button debounce (see initSchema comment) ----------
export function getLastButton(sql: SqlStorage, location: Location): number | null {
  return row<{ ts: number }>(sql.exec("SELECT ts FROM last_button WHERE location=?", location))?.ts ?? null;
}

export function setLastButton(sql: SqlStorage, location: Location, ts: number): void {
  sql.exec("INSERT INTO last_button (location, ts) VALUES (?, ?) ON CONFLICT(location) DO UPDATE SET ts=excluded.ts", location, ts);
}

// ---------- UI view ----------
export function mooseView(sql: SqlStorage, m: Moose, cfg: Config): MooseView {
  const t = now();
  const maxGap = cfg.maxGapMinutes * 60;
  const target = cfg.targetDegreeDays;
  const outEnd = m.in_start ?? m.done_at ?? t;
  const inEnd = m.done_at ?? t;
  const ddOut = degreeDays(sql, "ute", m.out_start, outEnd, maxGap);
  const ddIn = m.in_start != null ? degreeDays(sql, "inne", m.in_start, inEnd, maxGap) : 0.0;
  const total = ddOut + ddIn;
  const stage: MooseView["stage"] = m.done_at != null ? "klar" : m.in_start != null ? "inne" : "ute";

  let eta: number | null = null;
  if (m.done_at == null && total < target) {
    const cur = latestTemp(sql, stage as Location);
    if (cur && cur.temp > 0) eta = t + Math.round(((target - total) / cur.temp) * 86_400);
  }

  return {
    ...m,
    stage,
    hours_out: (outEnd - (m.out_start ?? 0)) / 3600.0,
    hours_in: m.in_start != null ? (inEnd - m.in_start) / 3600.0 : 0.0,
    dd_out: ddOut,
    dd_in: ddIn,
    dd_total: total,
    eta_ts: eta,
  };
}
