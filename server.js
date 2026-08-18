"use strict";

const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const FIVE_MINUTES = 5 * 60 * 1000;

app.use(express.json({ limit: "256kb" }));
app.use(express.text({ type: "*/*", limit: "256kb" }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

let lastTick = null;
let lastCandlePacket = null;

function normalizeBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body.trim()) {
    try { return JSON.parse(req.body); } catch (_error) { return null; }
  }
  return null;
}

function epochMilliseconds(value) {
  let timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return NaN;
  if (timestamp < 100000000000) timestamp *= 1000;
  return Math.trunc(timestamp);
}

function broadcast(payload) {
  const message = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  });
}

function validateTick(tick) {
  if (!tick) return "Body is empty or not valid JSON";
  if (!tick.symbol) return "Missing symbol";
  if (tick.bid == null) return "Missing bid";
  if (tick.ask == null) return "Missing ask";
  if (!Number.isFinite(Number(tick.bid))) return "bid is not a number";
  if (!Number.isFinite(Number(tick.ask))) return "ask is not a number";
  return null;
}

function acceptTick(tick) {
  const clean = {
    symbol: String(tick.symbol),
    bid: Number(tick.bid),
    ask: Number(tick.ask),
    digits: tick.digits != null ? Number(tick.digits) : null,
    time: tick.time != null ? Number(tick.time) : null,
    received_at: Date.now()
  };
  lastTick = clean;
  broadcast(clean);
  return clean;
}

function normalizeCandlePacket(packet) {
  if (!packet || typeof packet !== "object") throw new Error("Body is empty or not valid JSON");
  if (!packet.symbol) throw new Error("Missing symbol");
  if (!Array.isArray(packet.candles) || !packet.candles.length) throw new Error("Missing candles array");
  if (packet.candles.length > 100) throw new Error("Maximum 100 candles per request");

  const receivedAt = Date.now();
  const brokerClock = epochMilliseconds(packet.server_time);
  const clockOffset = Number.isFinite(brokerClock) ? brokerClock - receivedAt : 0;
  const currentStart = Math.floor(receivedAt / FIVE_MINUTES) * FIVE_MINUTES;
  const candlesByTime = new Map();

  packet.candles.forEach((row) => {
    if (!row || typeof row !== "object") return;
    const rawTime = epochMilliseconds(row.time);
    const open = Number(row.open);
    const high = Number(row.high);
    const low = Number(row.low);
    const close = Number(row.close);
    const volume = Math.max(0, Number(row.volume || row.tick_volume || 0));
    if (![rawTime, open, high, low, close].every(Number.isFinite)) return;
    if (open <= 0 || close <= 0 || high < Math.max(open, close) || low > Math.min(open, close) || low <= 0) return;

    // MT5 bar times follow the broker clock. Remove its offset and round away
    // sub-second HTTP latency so the result lands on the correct local M5 slot.
    const time = Math.round((rawTime - clockOffset) / FIVE_MINUTES) * FIVE_MINUTES;
    if (time >= currentStart || time < currentStart - 7 * 24 * 60 * 60 * 1000) return;
    candlesByTime.set(time, { time, open, high, low, close, volume, confirmed: true, source: "broker-history" });
  });

  const candles = [...candlesByTime.values()].sort((left, right) => left.time - right.time);
  if (!candles.length) throw new Error("No valid completed M5 candles received");
  return {
    type: "candles",
    symbol: String(packet.symbol),
    interval: "M5",
    candles,
    received_at: receivedAt
  };
}

app.post(["/tick", "/webhook"], (req, res) => {
  const tick = normalizeBody(req);
  const error = validateTick(tick);
  if (error) return res.status(400).json({ ok: false, error });
  return res.json({ ok: true, saved: acceptTick(tick) });
});

app.post("/candles", (req, res) => {
  try {
    lastCandlePacket = normalizeCandlePacket(normalizeBody(req));
    broadcast(lastCandlePacket);
    return res.json({
      ok: true,
      saved: lastCandlePacket.candles.length,
      latest: lastCandlePacket.candles[lastCandlePacket.candles.length - 1]
    });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});

app.get("/health", (_req, res) => res.json({
  ok: true,
  lastTick,
  broker_candles: lastCandlePacket ? lastCandlePacket.candles.length : 0,
  latest_broker_candle: lastCandlePacket && lastCandlePacket.candles.length
    ? lastCandlePacket.candles[lastCandlePacket.candles.length - 1]
    : null
}));
app.get("/last", (_req, res) => res.json(lastTick || { ok: false }));
app.get("/candles", (_req, res) => res.json(lastCandlePacket || { ok: false, candles: [] }));
app.get("/", (_req, res) => res.send("HT5 Stream Server: /health, /last, POST /tick, POST/GET /candles, WS /ws"));

wss.on("connection", (socket) => {
  if (lastCandlePacket) socket.send(JSON.stringify(lastCandlePacket));
  if (lastTick) socket.send(JSON.stringify(lastTick));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("HT5 stream server running on port", PORT));
