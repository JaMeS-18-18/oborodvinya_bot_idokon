// index.js
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import "dotenv/config";
import dns from "dns";

// IPv4'ni ustun qo'yamiz (Node 18+)
try { dns.setDefaultResultOrder("ipv4first"); } catch {}

/* ============ App ============ */
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_IDS = String(process.env.TELEGRAM_CHAT_ID || "")
  .split(",").map(s => s.trim()).filter(Boolean);

/* ============ Health / Debug ============ */
// App Platform health-check
app.get("/", (_req, res) => res.json({ ok: true, service: "telegram-order" }));
// Qo'shimcha test
app.get("/api/ping", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/* ============ Helpers ============ */
function escapeMdV2(s = "") {
  // Telegram MarkdownV2 escape
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

// fetch uchun timeout (AbortController)
async function timedFetch(url, opts = {}, ms = 12000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error("Fetch timeout")), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

// 4096 belgidan uzun xabarlarni bo‘lib yuboramiz
function splitTelegramMessage(text, limit = 4000) {
  if (!text || text.length <= limit) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > limit) {
    // oxirgi \n dan bo‘lamiz
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < 0) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  parts.push(rest);
  return parts;
}

/* ============ API ============ */
app.post("/api/telegram-order", async (req, res) => {
  console.log("[POST] /api/telegram-order IN");
  try {
    const { customer, items, total, source, createdAt } = req.body || {};
    if (!customer || !Array.isArray(items) || items.length === 0) {
      console.log(" -> bad payload");
      return res.status(400).json({ ok: false, error: "Bad payload" });
    }
    if (!BOT_TOKEN || CHAT_IDS.length === 0) {
      console.log(" -> telegram not configured");
      return res.status(500).json({ ok: false, error: "Telegram not configured" });
    }

    const baseUrl = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const fullText = buildMessage({ customer, items, total, source, createdAt });
    const chunks = splitTelegramMessage(fullText); // uzun bo'lsa bo'lib yuboramiz

    // har bir chatga, har bir bo'lakni ketma-ket yuboramiz
    const results = [];
    for (const chat_id of CHAT_IDS) {
      for (const chunk of chunks) {
        try {
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
          const body = await r.json().catch(() => ({}));
          results.push({ chat_id, httpOk: r.ok, tgOk: !!body.ok, body });
          if (!(r.ok && body.ok)) break; // shu chat uchun xato bo'lsa, qolgan bo'laklarni yubormaymiz
        } catch (err) {
          results.push({ chat_id, httpOk: false, tgOk: false, body: { error: String(err?.message || err) } });
          break;
        }
      }
    }

    const allOk = results.every(x => x.httpOk && x.tgOk);
    if (!allOk) {
      console.log(" -> telegram send failed", JSON.stringify(results));
      return res.status(502).json({ ok: false, error: "telegram send failed", details: results });
    }

    console.log(" -> OK");
    return res.json({ ok: true });
  } catch (e) {
    console.error("handler error", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

/* ============ Start ============ */
const PORT = process.env.PORT || 8080; // DO App Platform 8080
app.listen(PORT, () => console.log("Server started on", PORT));
