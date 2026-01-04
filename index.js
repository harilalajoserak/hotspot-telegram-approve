import express from "express";
import TelegramBot from "node-telegram-bot-api";
import crypto from "crypto";

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

const bot = new TelegramBot(BOT_TOKEN);

// fitahirizana request (tsotra)
const REQS = new Map();
const makeToken = () => crypto.randomBytes(16).toString("hex");

app.get("/", (req, res) => res.send("Server OK"));

/**
 * Client -> mangataka acces
 * Body: { mac, ip, profile, login, dst }
 */
app.post("/request", async (req, res) => {
  const { mac, ip, profile, login, dst } = req.body || {};
  if (!mac || !profile) return res.status(400).json({ error: "mac/profile required" });

  const token = makeToken();
  REQS.set(token, { state: "PENDING", mac, ip, profile, login, dst });

  const approveUrl = `${req.protocol}://${req.get("host")}/approve?token=${token}`;
  const denyUrl = `${req.protocol}://${req.get("host")}/deny?token=${token}`;

  await bot.sendMessage(
    ADMIN_CHAT_ID,
    `🔔 Demande accès Hotspot\nMAC: ${mac}\nIP: ${ip || "-"}\nProfil: ${profile}\n\n✅ OK: ${approveUrl}\n❌ Refuse: ${denyUrl}`
  );

  res.json({ token });
});

app.get("/status", (req, res) => {
  const token = req.query.token;
  const data = REQS.get(token);
  if (!data) return res.json({ state: "UNKNOWN" });
  res.json(data);
});

app.get("/approve", async (req, res) => {
  const token = req.query.token;
  const data = REQS.get(token);
  if (!data) return res.status(404).send("Token inconnu");

  // Amin'izao dingana 3 izao: mbola "approved" fotsiny, tsy mbola Mikrotik
  REQS.set(token, { ...data, state: "APPROVED" });
  res.send("✅ Approved (test). Dingana manaraka: MikroTik auto-login.");
});

app.get("/deny", (req, res) => {
  const token = req.query.token;
  const data = REQS.get(token);
  if (!data) return res.status(404).send("Token inconnu");
  REQS.set(token, { ...data, state: "DENIED" });
  res.send("❌ Refusé");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
// Demo: tsindry fotsiny -> mandefa demande any Telegram
app.get("/demo-request", async (req, res) => {
  const profile = req.query.profile || "1h";

  const mac = req.query.mac || "AA:BB:CC:DD:EE:FF";
  const ip = req.query.ip || "11.11.11.50";

  const token = makeToken();
  REQS.set(token, { state: "PENDING", mac, ip, profile });

  const approveUrl = `${req.protocol}://${req.get("host")}/approve?token=${token}`;
  const denyUrl = `${req.protocol}://${req.get("host")}/deny?token=${token}`;

  await bot.sendMessage(
    ADMIN_CHAT_ID,
    `🔔 DEMO Demande accès Hotspot\nMAC: ${mac}\nIP: ${ip}\nProfil: ${profile}\n\n✅ OK: ${approveUrl}\n❌ Refuse: ${denyUrl}`
  );

  res.send(`DEMO sent. Token=${token}`);
});
