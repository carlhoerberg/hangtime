// Fakes a Shelly BLU Gateway's outbound WebSocket connection for local testing,
// sending the same NotifyStatus/NotifyEvent shapes the real gateway would push.
// Usage: GATEWAY_TOKEN=devtoken node test/simulate-gateway.mjs [ws://localhost:8787/ws]

const url = process.argv[2] ?? "ws://localhost:8787/ws";
const token = process.env.GATEWAY_TOKEN ?? "devtoken";

const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);

function send(msg) {
  console.log("-> ", JSON.stringify(msg));
  ws.send(JSON.stringify(msg));
}

ws.onopen = () => {
  console.log("connected");

  // Outside temperature reading.
  send({
    method: "NotifyStatus",
    params: { "bthomesensor:200": { value: 4.5 }, ts: Math.floor(Date.now() / 1000) },
  });

  // Button press outside -> should create a new moose.
  setTimeout(() => {
    send({
      method: "NotifyEvent",
      params: { events: [{ component: "bthomesensor:203", event: "single_push", ts: Math.floor(Date.now() / 1000) }] },
    });
  }, 500);

  // Cold room temperature reading.
  setTimeout(() => {
    send({
      method: "NotifyStatus",
      params: { "bthomesensor:204": { value: 2.1 }, ts: Math.floor(Date.now() / 1000) },
    });
  }, 1000);

  // Button press in cold room -> should move the moose inside.
  setTimeout(() => {
    send({
      method: "NotifyEvent",
      params: { events: [{ component: "bthomesensor:207", event: "single_push", ts: Math.floor(Date.now() / 1000) }] },
    });
    setTimeout(() => ws.close(), 500);
  }, 1500);
};

ws.onerror = (e) => console.error("error", e.message ?? e);
ws.onclose = () => console.log("closed");
