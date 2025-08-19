import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import "dotenv/config";
import dns from "dns";

// IPv4'ni ustun qo'yamiz (Node 18+)
try { dns.setDefaultResultOrder("ipv4first"); } catch {}

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_IDS = String(process.env.TELEGRAM_CHAT_ID || "")
  .split(",").map(s => s.trim()).filter(Boolean);

app.get("/", (_req, res) => res.json({ ok: true, service: "telegram-order" }));

app.post("/api/telegram-order", async (req, res) => {
  try {
    const { customer, items, total, source, createdAt } = req.body || {};
    if (!customer || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: "Bad payload" });
    }
    if (!BOT_TOKEN || CHAT_IDS.length === 0) {
      return res.status(500).json({ ok: false, error: "Telegram not configured" });
    }

    const text = buildMessage({ customer, items, total, source, createdAt });

    // --- yuborish helperi: timeout + json tekshiruv ---
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const sendTo = (chat_id) => timedFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id, text, parse_mode: "MarkdownV2", disable_web_page_preview: true }),
    }, 12000) // 12s timeout
      .then(async r => ({ httpOk: r.ok, body: await safeJson(r) }))
      .catch(err => ({ httpOk: false, body: { ok: false, error: String(err?.message || err) } }));

    const results = await Promise.all(CHAT_IDS.map(sendTo));
    const allOk = results.every(r => r.httpOk && r.body?.ok);

    if (!allOk) {
      return res.status(502).json({ ok: false, error: "telegram send failed", details: results });
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

const PORT = process.env.PORT || 8080; // DO App Platform uchun 8080
app.listen(PORT, () => console.log("Server started on", PORT));

/* ===== Helpers ===== */
function buildMessage({ customer, items, total, source, createdAt }) {
  const fmt = n => new Intl.NumberFormat("uz-UZ").format(Number(n || 0)) + "$";
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

function escapeMdV2(s = "") {
  return String(s).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

async function timedFetch(url, opts = {}, ms = 10000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error("Fetch timeout")), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

async function safeJson(res) {
  try { return await res.json(); } catch { return {}; }
}
