import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import "dotenv/config";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// Bir yoki bir nechta chat_id (vergul bilan)
const CHAT_IDS = String(process.env.TELEGRAM_CHAT_ID || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.post("/api/telegram-order", async (req, res) => {
  try {
    const { customer, items, total, source, createdAt } = req.body || {};
    if (!customer || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ ok: false, error: "Bad payload" });
    }
    if (!BOT_TOKEN || CHAT_IDS.length === 0) {
      return res.status(500).json({ ok: false, error: "Telegram not configured" });
    }

    const lines = [
  "🧾 *Yangi buyurtma*",
  "",
  `👤 *Mijoz:* ${escapeMd(customer.name)}`,
  `📞 *Telefon:* ${escapeMd(customer.phone)}`,
  "",
  "📦 *Buyurtma tarkibi:*",
  ...items.map((it, i) =>
    `   ${i + 1}) ${escapeMd(it.title)}\n      └ ${it.qty} × ${fmt(it.price)} = *${fmt(it.subtotal)}*`
  ),
  "",
  `💰 *Jami:* ${fmt(total)}`,
  customer.note ? `🗒 *Izoh:* ${escapeMd(customer.note)}` : "",
  "",
  `📅 *Sana:* ${new Date(createdAt || Date.now()).toLocaleString("uz-UZ")}`
].filter(Boolean);


    const text = lines.join("\n");
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

    // Bir nechta guruhga parallel yuborish
    const sends = CHAT_IDS.map(chat_id =>
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id, text, parse_mode: "Markdown" })
      })
    );
    const results = await Promise.all(sends);
    const allOk = results.every(r => r.ok);

    if (!allOk) {
      const bodies = await Promise.all(results.map(r => r.text()));
      return res.status(502).json({ ok: false, error: bodies });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.listen(process.env.PORT || 5173, () => console.log("Server started"));

function fmt(n) {
  return new Intl.NumberFormat("uz-UZ").format(n) + "$";
}
// Markdown (V1) uchun minimal escape
function escapeMd(s = "") {
  return String(s).replace(/[<_>\[\]\(\)\*\~\`\#\+\-\=\|]/g, "\\$&");
}
