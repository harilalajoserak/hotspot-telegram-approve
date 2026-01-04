import express from "express";
import TelegramBot from "node-telegram-bot-api";
import crypto from "crypto";
import fs from "fs";

const app = express();
app.use(express.json());

// ===== ENV =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const POLL_KEY = process.env.POLL_KEY; // secret key hiarovana /poll-text & /consume

if (!BOT_TOKEN || !ADMIN_CHAT_ID || !POLL_KEY) {
  console.error("❌ Missing env: BOT_TOKEN / ADMIN_CHAT_ID / POLL_KEY");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// ===== Storage (file) =====
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

// ===== Utils =====
function safeDuration(d) {
  // RouterOS time format: 30s, 5m, 1h, 1d, 1w...
  if (!d) return "1h";
  const s = String(d).trim();
  if (/^\d+(s|m|h|d|w)$/i.test(s)) return s.toLowerCase();
  return "1h";
}

function baseUrlFromReq(req) {
  // Render matetika mampiasa proxy => trust X-Forwarded-Proto
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  return `${proto}://${req.get("host")}`;
}

function requireKey(req, res) {
  const key = req.query.key;
  if (!key || key !== POLL_KEY) {
    res.status(403).send("Forbidden");
    return false;
  }
  return true;
}

app.get("/", (req, res) => res.send("Server OK ✅"));

// ============ Client -> mangataka acces ============
// Body: { mac, ip, profile, login, dst }
app.post("/request", async (req, res) => {
  const { mac, ip, profile, login, dst } = req.body || {};
  if (!mac) return res.status(400).json({ error: "mac required" });

  const token = makeToken();
  const dur = safeDuration(profile);

  REQS[token] = {
    state: "PENDING",
    mac,
    ip: ip || "",
    profile: dur,
    login: login || "",
    dst: dst || "",
    createdAt: Date.now(),
  };
  saveReqs(REQS);

  const baseUrl = baseUrlFromReq(req);
  const approveUrl = `${baseUrl}/approve?token=${token}`;
  const denyUrl = `${baseUrl}/deny?token=${token}`;

  await bot.sendMessage(
    ADMIN_CHAT_ID,
    `🔔 Demande accès Hotspot\nMAC: ${mac}\nIP: ${ip || "-"}\nDurée: ${dur}\n\n✅ OK: ${approveUrl}\n❌ Refuse: ${denyUrl}`
  );

  res.json({ token });
});

// ============ Status ============
// /status?token=xxx
app.get("/status", (req, res) => {
  const token = req.query.token;
  const data = REQS[token];
  if (!data) return res.json({ state: "UNKNOWN" });
  res.json(data);
});

// ============ Approve / Deny ============
app.get("/approve", async (req, res) => {
  const token = req.query.token;
  const data = REQS[token];
  if (!data) return res.status(404).send("Token inconnu");

  REQS[token] = { ...data, state: "APPROVED", approvedAt: Date.now() };
  saveReqs(REQS);

  res.send("✅ Approved (OK). MikroTik no handray automatique.");
});

app.get("/deny", async (req, res) => {
  const token = req.query.token;
  const data = REQS[token];
  if (!data) return res.status(404).send("Token inconnu");

  REQS[token] = { ...data, state: "DENIED", deniedAt: Date.now() };
  saveReqs(REQS);

  res.send("❌ Refusé");
});

// ============ MikroTik Poll (OUTBOUND) ============
// MikroTik -> GET /poll-text?key=SECRET
// Response: "NONE" na "BYPASS|token|mac|ip|duration"
app.get("/poll-text", (req, res) => {
  if (!requireKey(req, res)) return;

  // mitady token APPROVED mbola tsy consumé
  const entries = Object.entries(REQS);
  const found = entries.find(([_, v]) => v && v.state === "APPROVED" && !v.consumedAt);

  if (!found) return res.send("NONE");

  const [token, v] = found;
  const mac = v.mac || "";
  const ip = v.ip || "";
  const duration = safeDuration(v.profile);

  // action 1: bypass
  return res.send(`BYPASS|${token}|${mac}|${ip}|${duration}`);
});

// ============ Consume ============
app.get("/consume", (req, res) => {
  if (!requireKey(req, res)) return;

  const token = req.query.token;
  const data = REQS[token];
  if (!data) return res.status(404).send("Token inconnu");

  REQS[token] = { ...data, consumedAt: Date.now() };
  saveReqs(REQS);

  res.send("OK");
});

// Demo quick
app.get("/demo-request", async (req, res) => {
  const dur = safeDuration(req.query.profile || "1h");
  const mac = req.query.mac || "AA:BB:CC:DD:EE:FF";
  const ip = req.query.ip || "11.11.11.50";

  const token = makeToken();
  REQS[token] = { state: "PENDING", mac, ip, profile: dur, createdAt: Date.now() };
  saveReqs(REQS);

  const baseUrl = baseUrlFromReq(req);
  const approveUrl = `${baseUrl}/approve?token=${token}`;
  const denyUrl = `${baseUrl}/deny?token=${token}`;

  await bot.sendMessage(
    ADMIN_CHAT_ID,
    `🔔 DEMO Demande accès Hotspot\nMAC: ${mac}\nIP: ${ip}\nDurée: ${dur}\n\n✅ OK: ${approveUrl}\n❌ Refuse: ${denyUrl}`
  );

  res.send(`DEMO sent ✅ Token=${token}`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
