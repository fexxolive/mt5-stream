// server.js
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();

// Parse JSON + fallback text (sometimes MT5 headers weird)
app.use(express.json({ limit: "256kb" }));
app.use(express.text({ type: "*/*", limit: "256kb" }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

let lastTick = null;

function normalizeBody(req) {
  // If express.json parsed it, req.body is object
  if (req.body && typeof req.body === "object") return req.body;

  // If it came as text, try JSON parse
  if (typeof req.body === "string" && req.body.trim().length) {
    try {
      return JSON.parse(req.body);
    } catch (e) {
      return null;
    }
  }
  return null;
}

function validateTick(tick) {
  if (!tick) return "Body is empty or not valid JSON";
  if (!tick.symbol) return "Missing symbol";
  if (tick.bid == null) return "Missing bid";
  if (tick.ask == null) return "Missing ask";

  const bid = Number(tick.bid);
  const ask = Number(tick.ask);
  if (!Number.isFinite(bid)) return "bid is not a number";
  if (!Number.isFinite(ask)) return "ask is not a number";

  return null;
}

function acceptTick(tick) {
  const clean = {
    symbol: String(tick.symbol),
    bid: Number(tick.bid),
    ask: Number(tick.ask),
    digits: tick.digits != null ? Number(tick.digits) : null,
    time: tick.time != null ? Number(tick.time) : null,
    received_at: Date.now(),
  };

  lastTick = clean;

  const msg = JSON.stringify(clean);
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });

  return clean;
}

// ✅ Support both /tick and /webhook
app.post(["/tick", "/webhook"], (req, res) => {
  const tick = normalizeBody(req);

  const err = validateTick(tick);
  if (err) {
    return res.status(400).json({
      ok: false,
      error: err,
      got_type: typeof req.body,
      got_body_preview:
        typeof req.body === "string" ? req.body.slice(0, 200) : req.body,
    });
  }

  const saved = acceptTick(tick);
  return res.json({ ok: true, saved });
});

app.get("/health", (req, res) => res.json({ ok: true, lastTick }));
app.get("/last", (req, res) =>
  res.json(lastTick ? lastTick : { ok: false })
);

// Optional: so browser doesn't show "Cannot GET /"
app.get("/", (req, res) => {
  res.send("✅ MT5 Stream Server is running. Use /health, /last, POST /tick, WS /ws");
});

wss.on("connection", (ws) => {
  if (lastTick) ws.send(JSON.stringify(lastTick));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("✅ Running on port", PORT));
