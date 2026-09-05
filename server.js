"use strict";

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
// Kept inline because the Render stream repository deploys server.js as a
// standalone service and does not include the desktop terminal's utilities.
function normalizeBrokerClockOffset(serverTime, utcTime, receivedAt = Date.now()) {
  const optionalClock = (value) => {
    if (value == null || value === "") return NaN;
    let timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return NaN;
    if (timestamp < 100000000000) timestamp *= 1000;
    return Math.trunc(timestamp);
  };
  const brokerClock = optionalClock(serverTime);
  const utcClock = optionalClock(utcTime);
  const receiptClock = optionalClock(receivedAt);
  const reportedOffset = Number.isFinite(brokerClock) && Number.isFinite(utcClock)
    ? brokerClock - utcClock
    : NaN;
  const maximumBrokerOffset = 6 * 60 * 60 * 1000;
  if (Number.isFinite(reportedOffset) && Math.abs(reportedOffset) <= maximumBrokerOffset) return reportedOffset;
  const receiptOffset = Number.isFinite(brokerClock) ? brokerClock - receiptClock : NaN;
  return Number.isFinite(receiptOffset) && Math.abs(receiptOffset) <= maximumBrokerOffset ? receiptOffset : 0;
}

const app = express();
const FIVE_MINUTES = 5 * 60 * 1000;
const HISTORY_PACKET_MAX_AGE = 3 * 60 * 1000;
const HISTORY_BAR_MAX_LAG = 4 * 24 * 60 * 60 * 1000;
const HISTORY_RETENTION = 30 * 24 * 60 * 60 * 1000;
const MAX_CANDLES_PER_SYMBOL = 500;
const HT5_SYMBOLS = Object.freeze([
  "XAUUSD",
  "EURUSD",
  "AUDJPY",
  "EURCAD",
  "AUDUSD",
  "AUDCHF",
  "EURCHF",
  "CHFJPY",
  "EURAUD"
]);

app.use(express.json({ limit: "2mb" }));
app.use(express.text({ type: "*/*", limit: "2mb" }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });
const ticksBySymbol = new Map();
const candlePacketsBySymbol = new Map();

function canonicalSymbol(value) {
  const raw = String(value || "").trim().toUpperCase();
  return HT5_SYMBOLS.find((symbol) => raw === symbol || raw.startsWith(`${symbol}.`) || raw.startsWith(`${symbol}+`) || raw.startsWith(`${symbol}_`) || raw.startsWith(`${symbol}-`)) || "";
}

function latestPacketCandleTime(packet) {
  if (!packet || !Array.isArray(packet.candles) || !packet.candles.length) return NaN;
  return Math.max(...packet.candles.map((candle) => Number(candle.time)).filter(Number.isFinite));
}

function isFreshCandlePacket(packet, now = Date.now()) {
  if (!packet || !Number.isFinite(Number(packet.received_at))) return false;
  const receivedAt = Number(packet.received_at);
  if (receivedAt > now + 5000 || now - receivedAt > HISTORY_PACKET_MAX_AGE) return false;
  const latest = latestPacketCandleTime(packet);
  const expectedLatestStart = Math.floor(now / FIVE_MINUTES) * FIVE_MINUTES - FIVE_MINUTES;
  return Number.isFinite(latest) && expectedLatestStart - latest <= HISTORY_BAR_MAX_LAG;
}

function freshCandlePacket(symbol, now = Date.now()) {
  const packet = candlePacketsBySymbol.get(canonicalSymbol(symbol));
  return isFreshCandlePacket(packet, now) ? packet : null;
}

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
  if (!tick || typeof tick !== "object") return "Body is empty or not valid JSON";
  if (!tick.symbol) return "Missing symbol";
  if (!canonicalSymbol(tick.symbol)) return `Unsupported symbol ${String(tick.symbol)}`;
  if (tick.bid == null) return "Missing bid";
  if (tick.ask == null) return "Missing ask";
  if (!Number.isFinite(Number(tick.bid))) return "bid is not a number";
  if (!Number.isFinite(Number(tick.ask))) return "ask is not a number";
  if (Number(tick.bid) <= 0 || Number(tick.ask) < Number(tick.bid)) return "Invalid bid/ask";
  return null;
}

function acceptTick(tick) {
  const symbol = canonicalSymbol(tick.symbol);
  const rawVolume = Number(tick.volume);
  const bid = Number(tick.bid);
  const ask = Number(tick.ask);
  const midpoint = (bid + ask) / 2;
  const dailyOpen = tick.daily_open != null ? Number(tick.daily_open) : NaN;
  const suppliedDailyChange = tick.daily_change_percent != null ? Number(tick.daily_change_percent) : NaN;
  const swapLong = tick.swap_long != null ? Number(tick.swap_long) : NaN;
  const swapShort = tick.swap_short != null ? Number(tick.swap_short) : NaN;
  const dailyChangePercent = Number.isFinite(suppliedDailyChange)
    ? suppliedDailyChange
    : Number.isFinite(dailyOpen) && dailyOpen > 0
      ? (midpoint - dailyOpen) / dailyOpen * 100
      : null;
  const clean = {
    symbol,
    broker_symbol: String(tick.broker_symbol || tick.symbol),
    bid,
    ask,
    digits: tick.digits != null && Number.isFinite(Number(tick.digits)) ? Number(tick.digits) : null,
    time: tick.time != null ? Number(tick.time) : null,
    volume: Number.isFinite(rawVolume) && rawVolume >= 0 ? Math.trunc(rawVolume) : 1,
    daily_open: Number.isFinite(dailyOpen) && dailyOpen > 0 ? dailyOpen : null,
    daily_change_percent: Number.isFinite(dailyChangePercent) ? dailyChangePercent : null,
    swap_long: Number.isFinite(swapLong) ? swapLong : null,
    swap_short: Number.isFinite(swapShort) ? swapShort : null,
    received_at: Date.now()
  };
  ticksBySymbol.set(symbol, clean);
  return clean;
}

function normalizeCandlePacket(packet) {
  if (!packet || typeof packet !== "object") throw new Error("Body is empty or not valid JSON");
  const symbol = canonicalSymbol(packet.symbol);
  if (!symbol) throw new Error(`Unsupported symbol ${String(packet.symbol || "(missing)")}`);
  if (!Array.isArray(packet.candles) || !packet.candles.length) throw new Error("Missing candles array");
  if (packet.candles.length > MAX_CANDLES_PER_SYMBOL) throw new Error(`Maximum ${MAX_CANDLES_PER_SYMBOL} candles per request`);

  const receivedAt = Date.now();
  // Never derive the broker offset from wall-clock receipt time alone. MT5's
  // TimeCurrent can freeze while the market is closed and that used to slide
  // the final Friday candles forward across the weekend on every new post.
  const clockOffset = normalizeBrokerClockOffset(packet.server_time, packet.utc_time, receivedAt);
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

    const time = Math.round((rawTime - clockOffset) / FIVE_MINUTES) * FIVE_MINUTES;
    if (time >= currentStart || time < currentStart - HISTORY_RETENTION) return;
    candlesByTime.set(time, { time, open, high, low, close, volume, confirmed: true, source: "broker-history" });
  });

  const existing = candlePacketsBySymbol.get(symbol);
  if (existing && Array.isArray(existing.candles)) {
    existing.candles.forEach((candle) => {
      if (!candlesByTime.has(candle.time)) candlesByTime.set(candle.time, candle);
    });
  }
  const candles = [...candlesByTime.values()]
    .sort((left, right) => left.time - right.time)
    .slice(-MAX_CANDLES_PER_SYMBOL);
  if (!candles.length) throw new Error("No valid completed M5 candles received");
  const latestCandleTime = candles[candles.length - 1].time;
  const expectedLatestStart = currentStart - FIVE_MINUTES;
  if (expectedLatestStart - latestCandleTime > HISTORY_BAR_MAX_LAG) {
    throw new Error("Broker M5 history is outdated; waiting for current completed bars");
  }
  return {
    type: "candles",
    symbol,
    broker_symbol: String(packet.broker_symbol || packet.symbol),
    interval: "M5",
    candles,
    latest_candle_time: latestCandleTime,
    received_at: receivedAt
  };
}

app.post(["/tick", "/webhook"], (req, res) => {
  const tick = normalizeBody(req);
  const error = validateTick(tick);
  if (error) return res.status(400).json({ ok: false, error });
  const saved = acceptTick(tick);
  broadcast(saved);
  return res.json({ ok: true, saved });
});

app.post("/ticks", (req, res) => {
  const body = normalizeBody(req);
  const rows = Array.isArray(body) ? body : body && Array.isArray(body.ticks) ? body.ticks : [];
  if (!rows.length || rows.length > HT5_SYMBOLS.length) return res.status(400).json({ ok: false, error: `Expected 1-${HT5_SYMBOLS.length} ticks` });
  const errors = rows.map(validateTick).filter(Boolean);
  if (errors.length) return res.status(400).json({ ok: false, error: errors[0] });
  const ticks = rows.map(acceptTick);
  const packet = { type: "ticks", ticks, received_at: Date.now() };
  broadcast(packet);
  return res.json({ ok: true, saved: ticks.length, symbols: ticks.map((tick) => tick.symbol) });
});

app.post("/candles", (req, res) => {
  try {
    const packet = normalizeCandlePacket(normalizeBody(req));
    candlePacketsBySymbol.set(packet.symbol, packet);
    broadcast(packet);
    return res.json({
      ok: true,
      symbol: packet.symbol,
      saved: packet.candles.length,
      latest: packet.candles[packet.candles.length - 1]
    });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});

app.get("/health", (_req, res) => {
  const now = Date.now();
  const symbols = HT5_SYMBOLS.map((symbol) => {
    const tick = ticksBySymbol.get(symbol) || null;
    const packet = freshCandlePacket(symbol, now);
    return {
      symbol,
      tick,
      broker_history_fresh: Boolean(packet),
      broker_history_packet_age_ms: packet ? Math.max(0, now - Number(packet.received_at || 0)) : null,
      broker_candles: packet ? packet.candles.length : 0,
      latest_broker_candle: packet ? packet.candles[packet.candles.length - 1] : null
    };
  });
  return res.json({ ok: true, configured_symbols: HT5_SYMBOLS, symbols });
});

app.get("/last", (req, res) => {
  const requested = canonicalSymbol(req.query.symbol);
  if (requested) return res.json(ticksBySymbol.get(requested) || { ok: false, symbol: requested });
  return res.json({ type: "ticks", ticks: [...ticksBySymbol.values()], received_at: Date.now() });
});

app.get("/candles", (req, res) => {
  const requested = canonicalSymbol(req.query.symbol);
  if (requested) {
    const packet = freshCandlePacket(requested);
    if (!packet) return res.status(503).json({ ok: false, symbol: requested, candles: [], error: "No fresh broker M5 history is available" });
    return res.json(packet);
  }
  const packets = HT5_SYMBOLS.map((symbol) => freshCandlePacket(symbol)).filter(Boolean);
  if (!packets.length) return res.status(503).json({ ok: false, packets: [], error: "No fresh broker M5 history is available" });
  return res.json({ type: "candles-batch", packets, received_at: Date.now() });
});

app.get("/", (_req, res) => res.send("HT5 Multi-Symbol Stream Server: /health, /last, POST /tick, POST /ticks, POST/GET /candles, WS /ws"));

wss.on("connection", (socket) => {
  HT5_SYMBOLS.forEach((symbol) => {
    const packet = freshCandlePacket(symbol);
    if (packet) socket.send(JSON.stringify(packet));
  });
  const ticks = [...ticksBySymbol.values()];
  if (ticks.length) socket.send(JSON.stringify({ type: "ticks", ticks, received_at: Date.now() }));
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log("HT5 multi-symbol stream server running on port", PORT));
}

module.exports = {
  HT5_SYMBOLS,
  MAX_CANDLES_PER_SYMBOL,
  app,
  canonicalSymbol,
  normalizeCandlePacket,
  server,
  ticksBySymbol,
  candlePacketsBySymbol
};
