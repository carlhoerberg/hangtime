import type { Env } from "./types";

export { HangtimeDO } from "./durable-object";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws" || url.pathname.startsWith("/api/")) {
      const id = env.MOOSE_DO.idFromName("singleton");
      const stub = env.MOOSE_DO.get(id);
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
