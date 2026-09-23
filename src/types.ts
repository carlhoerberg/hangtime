export type Location = "ute" | "inne";

export interface Env {
  MOOSE_DO: DurableObjectNamespace;
  ASSETS: Fetcher;
  APP_PASSWORD: string;
  GATEWAY_TOKEN: string;
  TARGET_DEGREE_DAYS: string | number;
  MAX_GAP_MINUTES: string | number;
}

export interface Config {
  targetDegreeDays: number;
  maxGapMinutes: number;
}

export interface Moose {
  id: number;
  name: string;
  out_start: number | null;
  in_start: number | null;
  done_at: number | null;
  weight_kg: number | null;
  comment: string;
  created_at: number;
}

export interface MooseView extends Moose {
  stage: "ute" | "inne" | "klar";
  hours_out: number;
  hours_in: number;
  dd_out: number;
  dd_in: number;
  dd_total: number;
  eta_ts: number | null;
}

export interface Reading {
  id: number;
  location: Location;
  ts: number;
  temp: number;
}

export interface Humidity {
  id: number;
  location: Location;
  ts: number;
  rh: number;
}

export interface EventRow {
  id: number;
  ts: number;
  location: Location | null;
  type: string;
  moose_id: number | null;
  note: string | null;
  name: string | null;
}

export type ComponentKind = "temperature" | "humidity" | "button";

export interface ComponentMap {
  [componentId: string]: { location: Location; kind: ComponentKind };
}

export interface RpcMessage {
  method?: string;
  params?: Record<string, unknown>;
}
