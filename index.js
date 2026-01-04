import express from "express";
import TelegramBot from "node-telegram-bot-api";
import crypto from "crypto";
import fs from "fs";

const app = express();
app.use(express.json());

// ================== ENV ==================
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
  console.error("❌ BOT_TOKEN / ADMIN_CHAT_ID missing in env");
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

// ================== Routes ==================
app.get("/", (req, res) => res.send("Server OK ✅"));

/**
 * Client -> mangataka acces
 * Body: { mac, ip, profile, login, dst }
 */
app.post("/request", async (req, res) => {
  try {
    const { mac, ip, profile, login, dst } = req.body || {};
    if (!mac || !profile) return res.status(400).json({ error: "mac/profile required" });

    const token = makeToken();
    REQS[token] = { state: "PENDING", mac, ip, profile, login, dst, createdAt: Date.now() };
    saveReqs(REQS);

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const approveUrl = `${baseUrl}/approve?token=${token}`;
    const denyUrl = `${baseUrl}/deny?token=${token}`;

    await bot.sendMessage(
      ADMIN_CHAT_ID,
      `🔔 Demande accès Hotspot\nMAC: ${mac}\nIP: ${ip || "-"}\nProfil: ${profile}\n\n✅ OK: ${approveUrl}\n❌ Refuse: ${denyUrl}`
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

app.get("/approve", (req, res) => {
  const token = req.query.token;
  const data = REQS[token];
  if (!data) return res.status(404).send("Token inconnu");

  REQS[token] = { ...data, state: "APPROVED", approvedAt: Date.now() };
  saveReqs(REQS);

  res.send("✅ Approved (OK). MikroTik no handray automatique.");
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
 * - Avy eo manova azy ho "SENT" (mba tsy hiverina indray mandeha)
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

    // Mark as SENT to avoid duplicates
    for (const token of approvedTokens.slice(0, limit)) {
      REQS[token] = { ...REQS[token], state: "SENT", sentAt: Date.now() };
    }
    saveReqs(REQS);

    res.setHeader("Content-Type", "application/json");
    res.send(JSON.stringify(toSend));
  } catch (e) {
    console.error("approved error:", e);
    res.status(500).json({ error: "server error" });
  }
});

// Demo: tsindry fotsiny -> mandefa demande any Telegram
app.get("/demo-request", async (req, res) => {
  try {
    const profile = req.query.profile || "1h";
    const mac = req.query.mac || "AA:BB:CC:DD:EE:FF";
    const ip = req.query.ip || "11.11.11.50";

    const token = makeToken();
    REQS[token] = { state: "PENDING", mac, ip, profile, createdAt: Date.now() };
    saveReqs(REQS);

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const approveUrl = `${baseUrl}/approve?token=${token}`;
    const denyUrl = `${baseUrl}/deny?token=${token}`;

    await bot.sendMessage(
      ADMIN_CHAT_ID,
      `🔔 DEMO Demande accès Hotspot\nMAC: ${mac}\nIP: ${ip}\nProfil: ${profile}\n\n✅ OK: ${approveUrl}\n❌ Refuse: ${denyUrl}`
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
