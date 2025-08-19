// index.js (diagnostic build)
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import "dotenv/config";
import dns from "dns";

try { dns.setDefaultResultOrder("ipv4first"); } catch {}

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_IDS = String(process.env.TELEGRAM_CHAT_ID || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const TEST_ONLY = String(process.env.TEST_ONLY || "").toLowerCase() === "true";

/* ---------- Global request logger ---------- */
app.use((req, res, next) => {
  const t0 = Date.now();
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const len = req.headers["content-length"] || 0;
  console.log(`[REQ] ${req.method} ${req.originalUrl} ip=${ip} len=${len}`);
  res.on("finish", () => {
    console.log(`[RES] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - t0}ms)`);
  });
  next();
});

/* ---------- Health ---------- */
app.get("/", (_req, res) => res.json({ ok: true, service: "telegram-order" }));
app.get("/api/ping", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/* ---------- Telegram self test ---------- */
app.get("/api/tg-selftest", async (_req, res) => {
  if (!BOT_TOKEN) return res.status(500).json({ ok:false, error:"No BOT TOKEN" });
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/getMe`;
  const t0 = Date.now();
  try {
    const r = await fetch(url, { method: "GET" });
    const body = await r.json().catch(() => ({}));
    return res.json({ ok: r.ok && body.ok, httpOk: r.ok, body, ms: Date.now() - t0 });
  } catch (e) {
    console.error("[/api/tg-selftest] error:", e);
    return res.status(502).json({ ok:false, error:String(e?.message||e), ms: Date.now() - t0 });
  }
});

/* ---------- Helpers ---------- */
function escapeMdV2(s = "") {
  return String(s).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}
const fmt = n => new Intl.NumberFormat("uz-UZ").format(Number(n || 0)) + "$";

function buildMessage({ customer, items, total, source, createdAt }) {
  const e = escapeMdV2;
  const lines = [
    "🧾 *Yangi buyurtma*",
    "",
    `👤 *Mijoz:* ${e(customer.name)}`,
    `📞 *Telefon:* ${e(customer.phone)}`,
    "",
    "📦 *Buyurtma tarkibi:*",
    ...items.map((it, i) =>
      `   ${i + 1}) ${e(it.title)}\n      └ ${it.qty} × ${e(fmt(it.price))} = *${e(fmt(it.subtotal))}*`
    ),
    "",
    `💰 *Jami:* ${e(fmt(total))}`,
    customer.note ? `🗒 *Izoh:* ${e(customer.note)}` : "",
    "",
    `📅 *Sana:* ${e(new Date(createdAt || Date.now()).toLocaleString("uz-UZ"))}`,
    source ? `🔗 *Manba:* ${e(source)}` : ""
  ].filter(Boolean);
  return lines.join("\n");
}

async function timedFetch(url, opts = {}, ms = 12000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("Fetch timeout")), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

function splitTelegramMessage(text, limit = 4000) {
  if (!text || text.length <= limit) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < 0) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  parts.push(rest);
  return parts;
}

/* ---------- API ---------- */
app.post("/api/telegram-order", async (req, res) => {
  const t0 = Date.now();
  console.log("[POST] /api/telegram-order IN payloadKeys:",
    Object.keys(req.body || {}), "itemsLen:", (req.body?.items || []).length);

  try {
    const { customer, items, total, source, createdAt } = req.body || {};
    if (!customer || !Array.isArray(items) || items.length === 0) {
      console.log(" -> bad payload");
      return res.status(400).json({ ok: false, error: "Bad payload" });
    }
    if (!BOT_TOKEN || CHAT_IDS.length === 0) {
      console.log(" -> telegram not configured", { hasToken: !!BOT_TOKEN, chatIdsLen: CHAT_IDS.length });
      return res.status(500).json({ ok: false, error: "Telegram not configured" });
    }

    if (TEST_ONLY) {
      console.log(" -> TEST_ONLY=true, skipping Telegram send");
      return res.json({ ok: true, debug: true, skipped: true, tookMs: Date.now() - t0 });
    }

    const baseUrl = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const fullText = buildMessage({ customer, items, total, source, createdAt });
    const chunks = splitTelegramMessage(fullText);
    console.log(` -> will send to ${CHAT_IDS.length} chat(s), chunks=${chunks.length}`);

    const results = [];
    for (const chat_id of CHAT_IDS) {
      let partIndex = 0;
      for (const chunk of chunks) {
        partIndex++;
        const p0 = Date.now();
        try {
          console.log(`   -> sending chat_id=${chat_id} part=${partIndex}/${chunks.length} len=${chunk.length}`);
          const r = await timedFetch(baseUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id,
              text: chunk,
              parse_mode: "MarkdownV2",
              disable_web_page_preview: true
            })
          }, 12000);

          let body = {};
          try { body = await r.json(); } catch (je) {
            console.warn("   !! JSON parse failed:", je);
          }
          console.log(`   <- response chat_id=${chat_id} part=${partIndex} http=${r.status} tgOk=${body?.ok} (${Date.now() - p0}ms)`);

          results.push({ chat_id, part: partIndex, httpOk: r.ok, httpStatus: r.status, tgOk: !!body.ok, body });
          if (!(r.ok && body.ok)) {
            console.warn("   !! stop further parts for this chat due to failure");
            break;
          }
        } catch (err) {
          console.error(`   xx fetch error chat_id=${chat_id} part=${partIndex}:`, err);
          results.push({ chat_id, part: partIndex, httpOk: false, tgOk: false, body: { error: String(err?.message || err) } });
          break;
        }
      }
    }

    const allOk = results.every(x => x.httpOk && x.tgOk);
    if (!allOk) {
      console.log(" -> telegram send failed, details:", JSON.stringify(results));
      return res.status(502).json({ ok: false, error: "telegram send failed", details: results, tookMs: Date.now() - t0 });
    }

    console.log(" -> OK", `(${Date.now() - t0}ms)`);
    return res.json({ ok: true, tookMs: Date.now() - t0 });
  } catch (e) {
    console.error("handler error", e);
    return res.status(500).json({ ok: false, error: "Server error", msg: String(e?.message || e) });
  }
});

/* ---------- JSON parse error handler ---------- */
app.use((err, _req, res, _next) => {
  if (err?.type === "entity.parse.failed") {
    console.error("JSON parse error:", err);
    return res.status(400).json({ ok: false, error: "Invalid JSON" });
  }
  console.error("Unhandled middleware error:", err);
  return res.status(500).json({ ok: false, error: "Middleware error" });
});

/* ---------- Unhandled promise rejections ---------- */
process.on("unhandledRejection", (r) => {
  console.error("UNHANDLED REJECTION:", r);
});

/* ---------- Start ---------- */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  const masked = BOT_TOKEN ? BOT_TOKEN.slice(0, 6) + "..." : "(none)";
  console.log("Server started on", PORT, "| token:", masked, "| chats:", CHAT_IDS);
});
