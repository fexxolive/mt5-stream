// server.js
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(express.json({ limit: "64kb" }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

let lastTick = null;

// MT5 will POST here
app.post("/tick", (req, res) => {
  const tick = req.body;

  // Basic validation
  if (!tick || !tick.symbol || tick.bid == null || tick.ask == null) {
    return res.status(400).json({ ok: false, error: "Invalid tick payload" });
  }

  lastTick = { ...tick, received_at: Date.now() };

  const msg = JSON.stringify(lastTick);

  // Broadcast to all WS clients
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });

  res.json({ ok: true });
});

// Health + last tick
app.get("/health", (req, res) => res.json({ ok: true, lastTick }));
app.get("/last", (req, res) => res.json(lastTick || { ok: false }));

wss.on("connection", (ws) => {
  // Send last tick immediately on connect
  if (lastTick) ws.send(JSON.stringify(lastTick));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ MT5 Tick Server running:`);
  console.log(`HTTP  -> http://localhost:${PORT}/tick`);
  console.log(`WS    -> ws://localhost:${PORT}/ws`);
});
