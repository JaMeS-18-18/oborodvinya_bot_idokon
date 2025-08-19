import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import "dotenv/config";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_IDS = String(process.env.TELEGRAM_CHAT_ID || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// Soddaroq health-check
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

    // --- Matn tayyorlash (MarkdownV2) ---
    const lines = [
      "🧾 *Yangi buyurtma*",
      "",
      `👤 *Mijoz:* ${escapeMdV2(customer.name)}`,
      `📞 *Telefon:* ${escapeMdV2(customer.phone)}`,
      "",
      "📦 *Buyurtma tarkibi:*",
      ...items.map((it, i) =>
        `   ${i + 1}) ${escapeMdV2(it.title)}\n      └ ${it.qty} × ${escapeMdV2(fmt(it.price))} = *${escapeMdV2(fmt(it.subtotal))}*`
      ),
      "",
      `💰 *Jami:* ${escapeMdV2(fmt(total))}`,
      customer.note ? `🗒 *Izoh:* ${escapeMdV2(customer.note)}` : "",
      "",
      `📅 *Sana:* ${escapeMdV2(new Date(createdAt || Date.now()).toLocaleString("uz-UZ"))}`,
      source ? `\n🔗 *Manba:* ${escapeMdV2(source)}` : ""
    ].filter(Boolean);
    const text = lines.join("\n");

    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

    // Yuborish (har bir chatga), JSON natijani tekshiramiz
    const sends = CHAT_IDS.map(async (chat_id) => {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id,
          text,
          parse_mode: "MarkdownV2",
          disable_web_page_preview: true
        })
      });
      const body = await r.json().catch(() => ({}));
      return { httpOk: r.ok, tgOk: !!body.ok, body };
    });

    const results = await Promise.all(sends);
    const allOk = results.every(x => x.tgOk);

    if (!allOk) {
      return res
        .status(502)
        .json({ ok: false, error: "telegram send failed", details: results });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

const PORT = process.env.PORT || 5173;
app.listen(PORT, () => console.log(`Server started on ${PORT}`));

function fmt(n) {
  return new Intl.NumberFormat("uz-UZ").format(Number(n || 0)) + "$";
}

/**
 * Telegram MarkdownV2 escape
 * Ruxsat etilmagan belgilar: _ * [ ] ( ) ~ ` > # + - = | { } . !
 * Bundan tashqari \ o‘zi ham escape qilinadi
 */
function escapeMdV2(s = "") {
  return String(s).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}
