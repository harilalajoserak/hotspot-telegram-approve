import express from "express";
import TelegramBot from "node-telegram-bot-api";
import crypto from "crypto";
import fs from "fs";

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
  console.error("❌ BOT_TOKEN / ADMIN_CHAT_ID missing in env");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// ====== Storage (file) ======
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

app.get("/", (req, res) => res.send("Server OK ✅"));

/**
 * Client -> mangataka acces
 * Body: { mac, ip, profile, login, dst }
 */
app.post("/request", async (req, res) => {
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
});

app.get("/status", (req, res) => {
  const token = req.query.token;
  const data = REQS[token];
  if (!data) return res.json({ state: "UNKNOWN" });
  res.json(data);
});

app.get("/approve", async (req, res) => {
  const token = req.query.token;
  const data = REQS[token];
  if (!data) return res.status(404).send("Token inconnu");

  REQS[token] = { ...data, state: "APPROVED" };
  saveReqs(REQS);

  res.send("✅ Approved (OK). Dingana manaraka: MikroTik auto-login.");
});

app.get("/deny", (req, res) => {
  const token = req.query.token;
  const data = REQS[token];
  if (!data) return res.status(404).send("Token inconnu");

  REQS[token] = { ...data, state: "DENIED" };
  saveReqs(REQS);

  res.send("❌ Refusé");
});

// Demo: tsindry fotsiny -> mandefa demande any Telegram
app.get("/demo-request", async (req, res) => {
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
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
