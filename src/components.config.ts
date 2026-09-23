import type { ComponentMap } from "./types";

// Maps a Shelly BLU Gateway component id (BTHome sensor slot) to {location, kind}.
// Numeric ids must be discovered empirically per-gateway — connect with GATEWAY_TOKEN
// and watch the raw messages logged by webSocketMessage() during setup, same as the
// old UDP-based ingest.rb's `log_raw` option.
export const COMPONENTS: ComponentMap = {
  "bthomesensor:200": { location: "ute", kind: "temperature" },
  "bthomesensor:201": { location: "ute", kind: "humidity" },
  "bthomesensor:203": { location: "ute", kind: "button" },
  "bthomesensor:204": { location: "inne", kind: "temperature" },
  "bthomesensor:205": { location: "inne", kind: "humidity" },
  "bthomesensor:207": { location: "inne", kind: "button" },
};
