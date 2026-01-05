
import express from "express";
import TelegramBot from "node-telegram-bot-api";
import crypto from "crypto";
import fs from "fs";

const app = express();
app.use(express.json());

// ================== ENV ==================
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID; // ex: "123456789"
const PUBLIC_URL = process.env.PUBLIC_URL;       // ex: "https://xxxxx.onrender.com"

if (!BOT_TOKEN || !ADMIN_CHAT_ID || !PUBLIC_URL) {
  console.error("❌ BOT_TOKEN / ADMIN_CHAT_ID / PUBLIC_URL missing in env");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// ================== Storage (file) ==================
const DB_FILE = "./reqs.json";

function loadReqs() {
  try {
    if (!fs.existsSync(DB_FILE)) return {};
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8") || "{}");
  } catch (e) {
    console.error("loadReqs error:", e);
    return {};
  }
}

function saveReqs(obj) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error("saveReqs error:", e);
  }
}

let REQS = loadReqs();
const makeToken = () => crypto.randomBytes(16).toString("hex");

// ================== Helpers ==================
// Profile voafetra: 1h sy 3h ihany
function normalizeProfile(p) {
  return p === "3h" ? "3h" : p === "1h" ? "1h" : null;
}

// ================== Routes ==================
app.get("/", (req, res) => res.send("Server OK ✅"));

/**
 * ✅ Setup webhook (miantso azy indray mandeha rehefa deploy)
 * GET /setup-webhook
 */
app.get("/setup-webhook", async (req, res) => {
  try {
    const webhookUrl = `${PUBLIC_URL}/tg/webhook`;
    await bot.setWebHook(webhookUrl);
    res.send(`✅ Webhook set: ${webhookUrl}`);
  } catch (e) {
    console.error("setup-webhook error:", e);
    res.status(500).send("❌ setWebHook error");
  }
});

/**
 * Telegram webhook endpoint
 * Telegram no mandefa update rehefa tsindriana bokotra
 */
app.post("/tg/webhook", async (req, res) => {
  try {
    const update = req.body;

    // tokony hamaly 200 haingana
    res.sendStatus(200);

    if (!update || !update.callback_query) return;

    const cq = update.callback_query;
    const data = cq.data || ""; // ex: "APPROVE|<token>|1h"
    const chatId = cq.message?.chat?.id;

    // Security: ataovy azo antoka fa admin chat ihany no mahazo manova
    if (String(chatId) !== String(ADMIN_CHAT_ID)) {
      await bot.answerCallbackQuery(cq.id, { text: "❌ Tsy admin ianao", show_alert: true });
      return;
    }

    const parts = data.split("|");
    const action = parts[0];        // APPROVE or DENY
    const token = parts[1];
    const profile = parts[2];       // 1h/3h (raha approve)

    const reqData = REQS[token];
    if (!reqData) {
      await bot.answerCallbackQuery(cq.id, { text: "❌ Token inconnu", show_alert: true });
      return;
    }

    if (action === "APPROVE") {
      const p = normalizeProfile(profile);
      if (!p) {
        await bot.answerCallbackQuery(cq.id, { text: "❌ Profil tsy ekena", show_alert: true });
        return;
      }

      REQS[token] = {
        ...reqData,
        state: "APPROVED",
        profile: p,          // ✅ eto no apetraka ny 1h/3h
        approvedAt: Date.now(),
      };
      saveReqs(REQS);

      await bot.answerCallbackQuery(cq.id, { text: `✅ Approved (${p})` });

      // Ovay ny message mba hitan'ny admin fa vita
      await bot.editMessageText(
        `✅ APPROVED (${p})\nMAC: ${reqData.mac}\nIP: ${reqData.ip || "-"}\nToken: ${token}`,
        { chat_id: chatId, message_id: cq.message.message_id }
      );
      return;
    }

    if (action === "DENY") {
      REQS[token] = { ...reqData, state: "DENIED", deniedAt: Date.now() };
      saveReqs(REQS);

      await bot.answerCallbackQuery(cq.id, { text: "❌ Refusé" });
      await bot.editMessageText(
        `❌ DENIED\nMAC: ${reqData.mac}\nIP: ${reqData.ip || "-"}\nToken: ${token}`,
        { chat_id: chatId, message_id: cq.message.message_id }
      );
      return;
    }

    await bot.answerCallbackQuery(cq.id, { text: "❌ Action inconnue", show_alert: true });
  } catch (e) {
    console.error("tg/webhook error:", e);
    // aza mamaly eto satria efa res.sendStatus(200) etsy ambony
  }
});

/**
 * Client -> mangataka acces
 * Body: { mac, ip, login, dst }
 * ✅ profile tsy avy amin'ny client intsony eto (fa admin no misafidy 1h/3h)
 */
app.post("/request", async (req, res) => {
  try {
    const { mac, ip, login, dst } = req.body || {};
    if (!mac) return res.status(400).json({ error: "mac required" });

    const token = makeToken();
    REQS[token] = {
      state: "PENDING",
      mac,
      ip,
      login,
      dst,
      // profile mbola tsy voafidy raha tsy approve
      createdAt: Date.now(),
    };
    saveReqs(REQS);

    // bokotra inline Telegram
    const keyboard = {
      inline_keyboard: [
        [
          { text: "✅ Approve 1h", callback_data: `APPROVE|${token}|1h` },
          { text: "✅ Approve 3h", callback_data: `APPROVE|${token}|3h` },
        ],
        [{ text: "❌ Deny", callback_data: `DENY|${token}` }],
      ],
    };

    const approveUrl = `${PUBLIC_URL}/approve?token=${token}&profile=1h`; // backup
    const denyUrl = `${PUBLIC_URL}/deny?token=${token}`;                 // backup

    await bot.sendMessage(
      ADMIN_CHAT_ID,
      `🔔 Demande accès Hotspot\nMAC: ${mac}\nIP: ${ip || "-"}\nLogin: ${login || "-"}\nDST: ${dst || "-"}\n\n(Backup lien)\n✅ OK(1h): ${approveUrl}\n❌ Refuse: ${denyUrl}`,
      { reply_markup: keyboard }
    );

    res.json({ token });
  } catch (e) {
    console.error("request error:", e);
    res.status(500).json({ error: "server error" });
  }
});

app.get("/status", (req, res) => {
  const token = req.query.token;
  const data = REQS[token];
  if (!data) return res.json({ state: "UNKNOWN" });
  res.json(data);
});

// ✅ Backup approve via URL (fa profile 1h/3h ihany no ekena)
app.get("/approve", (req, res) => {
  const token = req.query.token;
  const profile = normalizeProfile(req.query.profile);

  if (!profile) return res.status(400).send("Profil tsy ekena (1h na 3h ihany)");
  const data = REQS[token];
  if (!data) return res.status(404).send("Token inconnu");

  REQS[token] = { ...data, state: "APPROVED", profile, approvedAt: Date.now() };
  saveReqs(REQS);

  res.send(`✅ Approved (${profile}). MikroTik no handray automatique.`);
});

app.get("/deny", (req, res) => {
  const token = req.query.token;
  const data = REQS[token];
  if (!data) return res.status(404).send("Token inconnu");

  REQS[token] = { ...data, state: "DENIED", deniedAt: Date.now() };
  saveReqs(REQS);

  res.send("❌ Refusé");
});

/**
 * ✅ Route ilain'ny MikroTik (POLL)
 * GET /approved?limit=5
 *
 * - Maka ireo "APPROVED"
 * - Avy eo manova azy ho "SENT" (mba tsy hiverina)
 * - Mamerina JSON array: [{ token, mac, ip, profile, login, dst, ... }]
 */
app.get("/approved", (req, res) => {
  try {
    const limit = Math.max(1, Math.min(parseInt(req.query.limit || "5", 10), 50));

    const approvedTokens = Object.keys(REQS).filter((t) => REQS[t]?.state === "APPROVED");
    const toSend = approvedTokens.slice(0, limit).map((token) => ({
      token,
      ...REQS[token],
    }));

    for (const token of approvedTokens.slice(0, limit)) {
      REQS[token] = { ...REQS[token], state: "SENT", sentAt: Date.now() };
    }
    saveReqs(REQS);

    res.json(toSend);
  } catch (e) {
    console.error("approved error:", e);
    res.status(500).json({ error: "server error" });
  }
});

// Demo: tsindry fotsiny -> mandefa demande any Telegram
app.get("/demo-request", async (req, res) => {
  try {
    const mac = req.query.mac || "AA:BB:CC:DD:EE:FF";
    const ip = req.query.ip || "11.11.11.50";

    const token = makeToken();
    REQS[token] = { state: "PENDING", mac, ip, createdAt: Date.now() };
    saveReqs(REQS);

    const keyboard = {
      inline_keyboard: [
        [
          { text: "✅ Approve 1h", callback_data: `APPROVE|${token}|1h` },
          { text: "✅ Approve 3h", callback_data: `APPROVE|${token}|3h` },
        ],
        [{ text: "❌ Deny", callback_data: `DENY|${token}` }],
      ],
    };

    await bot.sendMessage(
      ADMIN_CHAT_ID,
      `🔔 DEMO Demande accès Hotspot\nMAC: ${mac}\nIP: ${ip}\nToken: ${token}`,
      { reply_markup: keyboard }
    );

    res.send(`DEMO sent ✅ Token=${token}`);
  } catch (e) {
    console.error("demo-request error:", e);
    res.status(500).send("server error");
  }
});

// ================== Start ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
