// index.js
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import "dotenv/config";
import dns from "dns";

// IPv6/DNS bilan muammolarni kamaytirish
try { dns.setDefaultResultOrder("ipv4first"); } catch { }

/* ============ App ============ */
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_IDS = String(process.env.TELEGRAM_CHAT_ID || "")
  .split(",").map(s => s.trim()).filter(Boolean);

/* ---- Request logger ---- */
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - start}ms)`
    );
  });
  next();
});

/* ============ Health / Debug ============ */
app.get("/", (_req, res) => res.json({ ok: true, service: "telegram-order" }));
app.get("/api/ping", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Bot token to‘g‘riligini tekshirish
app.get("/api/tg-selftest", async (_req, res) => {
  try {
    if (!BOT_TOKEN) return res.status(500).json({ ok: false, error: "NO_TOKEN" });
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
    const body = await r.json().catch(() => ({}));
    res.status(r.ok ? 200 : 502).json({ httpOk: r.ok, body });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* ---- OPTIONS (preflight) ---- */
app.options("/api/telegram-order", cors());

/* ============ Helpers ============ */

// Valyuta formatlash (UZ locale, so‘m)
const fmtUZS = (n) => new Intl.NumberFormat("uz-UZ").format(Number(n || 0)) + " so‘m";

// HTML parse_mode uchun xavfsiz escape
function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Indent (NBSP)
const INDENT = "\u00A0\u00A0\u00A0\u00A0";

/**
 * Xabar matnini HTML formatida qurish
 * @param {Object} payload
 * @param {Object} payload.customer   {name, phone, note}
 * @param {Array}  payload.items      [{title, qty, price, subtotal}]
 * @param {number} payload.total      qurilmalar jami (so‘m)
 * @param {Object} payload.plan       {id, tag, cycle: 'monthly'|'yearly', priceUZS}
 * @param {Object} payload.install    {feeUZS, cycle, planId}  // ixtiyoriy
 * @param {number} payload.grandFirstPaymentUZS                // ixtiyoriy; bo‘lmasa hisoblab chiqaramiz
 * @param {string} payload.source
 * @param {string} payload.createdAt  ISO
 */
function buildMessageHTML({
  customer,
  items = [],
  total = 0,
  plan = null,
  install = null,
  grandFirstPaymentUZS,
  source,
  createdAt
}) {
  const e = escapeHtml;

  // Birinchi to‘lov (fallback)
  const computedGrand =
    (Number(total) || 0) +
    (Number(plan?.priceUZS) || 0) +
    (Number(install?.feeUZS) || 0);

  const grandToShow = typeof grandFirstPaymentUZS === "number"
    ? grandFirstPaymentUZS
    : computedGrand;

  const rows = [
    "🧾 <b>Yangi buyurtma</b>",
    "",
    `👤 <b>Mijoz:</b> ${e(customer?.name || "")}`,
    `📞 <b>Telefon:</b> ${e(customer?.phone || "")}`,
    "",
    items.length ? "📦 <b>Buyurtma tarkibi (qurilmalar):</b>" : "",
    ...items.map(it => {
      const title = e(it.title || "");
      const qty = Number(it.qty || 0);
      const price = fmtUZS(it.price);
      const subtotal = fmtUZS(it.subtotal ?? (qty * Number(it.price || 0)));
      return `• ${title}\n${INDENT}└ ${qty} × ${e(price)} = <b>${e(subtotal)}</b>`;
    }),
    plan
      ? `\n📝 <b>Ta'rif:</b> ${e(plan.tag)} — <b>${fmtUZS(plan.priceUZS)}</b> <i>/ ${plan.cycle === "yearly" ? "yil" : "oy"}</i>`
      : "",
    (install && Number(install.feeUZS) > 0)
      ? `🧩 <b>Ustanovka to‘lovi:</b> ${fmtUZS(install.feeUZS)}`
      : "",
    "",
    items.length ? `💰 <b>Qurilmalar jami:</b> ${fmtUZS(total)}` : "",
    (plan || (install && Number(install.feeUZS) > 0) || items.length)
      ? `📊 <b>Umumiy (birinchi to‘lov):</b> ${fmtUZS(grandToShow)}`
      : "",
    customer?.note ? `🗒 <b>Izoh:</b> ${e(customer.note)}` : "",
    "",
    `📅 <b>Sana:</b> ${e(new Date(createdAt || Date.now()).toLocaleString("uz-UZ"))}`,
    source ? `🔗 <b>Manba:</b> ${e(source)}` : ""
  ].filter(Boolean);

  return rows.join("\n");
}

// Timeout bilan fetch
async function timedFetch(url, opts = {}, ms = 12000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error("Fetch timeout")), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

// Telegram xabarini bo‘lib yuborish (limit ~4096, xavfsiz 4000)
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

/* ============ API ============ */
app.post("/api/telegram-order", async (req, res) => {
  console.log("[REQ] /api/telegram-order payload:", JSON.stringify(req.body).slice(0, 800));
  try {
    const {
      customer,
      items = [],
      total = 0,
      plan = null,
      install = null,              // { feeUZS, cycle, planId } bo‘lishi mumkin
      grandFirstPaymentUZS,        // ixtiyoriy; jo‘natilsa shu ko‘rsatiladi
      source,
      createdAt
    } = req.body || {};

    // Validatsiya: mijoz bo‘lishi shart; qurilmalar YOKI tarifning hech bo‘lmasa bittasi bo‘lsin
    const hasDevices = Array.isArray(items) && items.length > 0;
    const hasPlan = !!plan && typeof plan === "object";
    if (!customer || (!hasDevices && !hasPlan)) {
      console.log(" -> bad payload");
      return res.status(400).json({ ok: false, error: "Bad payload" });
    }
    if (!BOT_TOKEN || CHAT_IDS.length === 0) {
      console.log(" -> telegram not configured");
      return res.status(500).json({ ok: false, error: "Telegram not configured" });
    }

    const text = buildMessageHTML({
      customer,
      items,
      total,
      plan,
      install,
      grandFirstPaymentUZS,
      source,
      createdAt
    });

    const chunks = splitTelegramMessage(text);
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

    const results = [];
    for (const chat_id of CHAT_IDS) {
      for (const chunk of chunks) {
        console.log(` -> sending chat_id=${chat_id}, size=${chunk.length}`);
        try {
          const r = await timedFetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id,
              text: chunk,
              parse_mode: "HTML",
              disable_web_page_preview: true
            })
          }, 12000);
          const body = await r.json().catch(() => ({}));
          console.log(` <- response chat_id=${chat_id} http=${r.status} tgOk=${body?.ok}`);
          results.push({ chat_id, httpOk: r.ok, tgOk: !!body.ok, body });
          if (!(r.ok && body.ok)) break; // shu chat uchun xato bo'lsa, qolgan bo'laklarni yubormaymiz
        } catch (err) {
          console.error(" !! send error:", err?.message || err);
          results.push({ chat_id, httpOk: false, tgOk: false, body: { error: String(err?.message || err) } });
          break;
        }
      }
    }

    const allOk = results.every(x => x.httpOk && x.tgOk);
    if (!allOk) {
      console.log(" -> telegram send failed", JSON.stringify(results).slice(0, 900));
      return res.status(502).json({ ok: false, error: "telegram send failed", details: results });
    }

    console.log(" -> OK");
    return res.json({ ok: true });
  } catch (e) {
    console.error("handler error", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

/* ================== Contact form API ================== */
// POST /api/contact
// Body misol: { name: "Ali", phone: "+998901234567", message: "Salom, ..."}
app.post("/api/contact", async (req, res) => {
  console.log("[REQ] /api/contact payload:", JSON.stringify(req.body).slice(0, 500));
  try {
    const { name, phone, message } = req.body || {};
    if (!name || !phone || !message) {
      return res.status(400).json({ ok: false, error: "Missing fields" });
    }
    if (!BOT_TOKEN || CHAT_IDS.length === 0) {
      return res.status(500).json({ ok: false, error: "Telegram not configured" });
    }

    // Xabar matni
    const text =
      `📩 <b>Yangi murojaat</b>\n\n` +
      `👤 <b>Ism:</b> ${escapeHtml(name)}\n` +
      `📞 <b>Telefon:</b> ${escapeHtml(phone)}\n` +
      `🗒 <b>Xabar:</b>\n${escapeHtml(message)}\n\n` +
      `⏰ ${new Date().toLocaleString("uz-UZ")}`;

    // Telegramga yuborish
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const results = [];
    for (const chat_id of CHAT_IDS) {
      const r = await timedFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true
        })
      }, 12000);
      const body = await r.json().catch(() => ({}));
      results.push({ chat_id, httpOk: r.ok, tgOk: !!body.ok });
    }

    const allOk = results.every(r => r.httpOk && r.tgOk);
    if (!allOk) return res.status(502).json({ ok: false, error: "Telegram send failed", details: results });

    res.json({ ok: true });
  } catch (err) {
    console.error("contact error", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});


/* ============ Start ============ */
const PORT = process.env.PORT || 8090;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server started on ${PORT} | token: ${BOT_TOKEN?.slice(0, 6)}... | chats:`, CHAT_IDS);
});
