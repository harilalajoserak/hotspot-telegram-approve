import express from "express";
import TelegramBot from "node-telegram-bot-api";
import crypto from "crypto";
import net from "net";

const app = express();
app.use(express.json());

// ===================== ENV =====================
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

const MT_HOST = process.env.MT_HOST;              // ex: beeb0b9cb.sn.mynetname.net
const MT_PORT = Number(process.env.MT_PORT || 8728);
const MT_USER = process.env.MT_USER;
const MT_PASS = process.env.MT_PASS;
const HOTSPOT_SERVER = process.env.HOTSPOT_SERVER || "hotspot1";

if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
  console.warn("⚠️ BOT_TOKEN / ADMIN_CHAT_ID missing");
}
if (!MT_HOST || !MT_USER || !MT_PASS) {
  console.warn("⚠️ MT_HOST / MT_USER / MT_PASS missing (MikroTik API won't work)");
}

// Telegram bot (send only, no polling)
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// fitahirizana request (tsotra)
const REQS = new Map();
const makeToken = () => crypto.randomBytes(16).toString("hex");
const makePass = () => crypto.randomBytes(6).toString("hex");

// ===================== MikroTik API (RAW) =====================
// Minimal MikroTik API client (8728)
class MikroTikAPI {
  constructor({ host, port, user, pass, timeoutMs = 8000 }) {
    this.host = host;
    this.port = port;
    this.user = user;
    this.pass = pass;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
  }

  connect() {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      this.socket = sock;

      const to = setTimeout(() => {
        try { sock.destroy(); } catch {}
        reject(new Error("MikroTik API timeout (connect)"));
      }, this.timeoutMs);

      sock.on("connect", () => {
        clearTimeout(to);
        resolve();
      });
      sock.on("error", (err) => reject(err));
      sock.on("data", (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
      });
    });
  }

  close() {
    try { this.socket?.end(); } catch {}
  }

  // ---- API encoding helpers ----
  static encodeLength(len) {
    if (len < 0x80) return Buffer.from([len]);
    if (len < 0x4000) return Buffer.from([(len >> 8) | 0x80, len & 0xff]);
    if (len < 0x200000) return Buffer.from([(len >> 16) | 0xc0, (len >> 8) & 0xff, len & 0xff]);
    if (len < 0x10000000) return Buffer.from([(len >> 24) | 0xe0, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
    return Buffer.from([0xf0, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
  }

  static encodeWord(word) {
    const b = Buffer.from(word, "utf8");
    return Buffer.concat([MikroTikAPI.encodeLength(b.length), b]);
  }

  writeSentence(words) {
    const payload = Buffer.concat([...words.map(MikroTikAPI.encodeWord), Buffer.from([0])]);
    return new Promise((resolve, reject) => {
      this.socket.write(payload, (err) => (err ? reject(err) : resolve()));
    });
  }

  // read one sentence (array of words) from internal buffer
  async readSentence(timeoutMs = 8000) {
    const start = Date.now();
    while (true) {
      const res = this._tryParseSentence();
      if (res) return res;

      if (Date.now() - start > timeoutMs) throw new Error("MikroTik API timeout (read)");
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  _tryParseSentence() {
    let offset = 0;
    const words = [];

    const readLen = () => {
      if (this.buffer.length < offset + 1) return null;
      let c = this.buffer[offset];

      if (c < 0x80) {
        offset += 1;
        return c;
      }
      if (c < 0xc0) {
        if (this.buffer.length < offset + 2) return null;
        const len = ((c & 0x3f) << 8) + this.buffer[offset + 1];
        offset += 2;
        return len;
      }
      if (c < 0xe0) {
        if (this.buffer.length < offset + 3) return null;
        const len = ((c & 0x1f) << 16) + (this.buffer[offset + 1] << 8) + this.buffer[offset + 2];
        offset += 3;
        return len;
      }
      if (c < 0xf0) {
        if (this.buffer.length < offset + 4) return null;
        const len = ((c & 0x0f) << 24) + (this.buffer[offset + 1] << 16) + (this.buffer[offset + 2] << 8) + this.buffer[offset + 3];
        offset += 4;
        return len;
      }
      // 0xF0
      if (this.buffer.length < offset + 5) return null;
      const len = (this.buffer[offset + 1] << 24) + (this.buffer[offset + 2] << 16) + (this.buffer[offset + 3] << 8) + this.buffer[offset + 4];
      offset += 5;
      return len;
    };

    while (true) {
      const len = readLen();
      if (len === null) return null;

      if (len === 0) {
        // consume parsed bytes
        this.buffer = this.buffer.slice(offset);
        return words;
      }

      if (this.buffer.length < offset + len) return null;
      const w = this.buffer.slice(offset, offset + len).toString("utf8");
      offset += len;
      words.push(w);
    }
  }

  async talk(words) {
    await this.writeSentence(words);
    const replies = [];
    while (true) {
      const sentence = await this.readSentence();
      replies.push(sentence);
      if (sentence[0] === "!done") break;
      if (sentence[0] === "!trap") break;
      if (sentence[0] === "!fatal") break;
    }
    return replies;
  }

  async login() {
    // /login =name=... =password=...
    const r = await this.talk(["/login", `=name=${this.user}`, `=password=${this.pass}`]);
    const first = r[0]?.[0];
    if (first !== "!done") {
      const msg = JSON.stringify(r);
      throw new Error("Login failed: " + msg);
    }
  }
}

async function mikrotikAddHotspotUser({ username, password, profile, mac, comment, server }) {
  const api = new MikroTikAPI({ host: MT_HOST, port: MT_PORT, user: MT_USER, pass: MT_PASS });

  await api.connect();
  try {
    await api.login();

    // add hotspot user
    const replies = await api.talk([
      "/ip/hotspot/user/add",
      `=name=${username}`,
      `=password=${password}`,
      `=profile=${profile}`,
      `=server=${server}`,
      `=mac-address=${mac}`,
      comment ? `=comment=${comment}` : "",
    ].filter(Boolean));

    // optional: try active login (if client already active)
    // (Sometimes it works only if ip is known and client is in active list)
    // We don't hard-fail if it doesn't.
    // return replies for debug
    return replies;
  } finally {
    api.close();
  }
}

// ===================== ROUTES =====================
app.get("/", (req, res) => res.send("Server OK"));

/**
 * Client -> mangataka acces
 * Body: { mac, ip, profile, login, dst }
 */
app.post("/request", async (req, res) => {
  try {
    const { mac, ip, profile, login, dst } = req.body || {};
    if (!mac || !profile) return res.status(400).json({ error: "mac/profile required" });

    const token = makeToken();
    REQS.set(token, { state: "PENDING", mac, ip, profile, login, dst });

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const approveUrl = `${baseUrl}/approve?token=${token}`;
    const denyUrl = `${baseUrl}/deny?token=${token}`;

    await bot.sendMessage(
      ADMIN_CHAT_ID,
      `🔔 Demande accès Hotspot\nMAC: ${mac}\nIP: ${ip || "-"}\nProfil: ${profile}\n\n✅ OK: ${approveUrl}\n❌ Refuse: ${denyUrl}`
    );

    res.json({ token, state: "PENDING" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

app.get("/status", (req, res) => {
  const token = req.query.token;
  const data = REQS.get(token);
  if (!data) return res.json({ state: "UNKNOWN" });
  res.json(data);
});

// ✅ Approve -> CREATE USER on MikroTik
app.get("/approve", async (req, res) => {
  const token = req.query.token;
  const data = REQS.get(token);
  if (!data) return res.status(404).send("Token inconnu");

  const { mac, profile, ip } = data;

  // create username/password from MAC
  const clean = String(mac).replace(/[^0-9A-Fa-f]/g, "").toLowerCase();
  const username = `hs_${clean.slice(-8)}`; // ex: hs_a1b2c3d4
  const password = makePass();

  try {
    // add user in MikroTik
    if (!MT_HOST || !MT_USER || !MT_PASS) {
      throw new Error("Missing MT_HOST/MT_USER/MT_PASS in env");
    }

    await mikrotikAddHotspotUser({
      username,
      password,
      profile,
      mac,
      comment: `APPROVED token=${token} ip=${ip || "-"}`,
      server: HOTSPOT_SERVER,
    });

    REQS.set(token, {
      ...data,
      state: "APPROVED",
      created_user: username,
      created_pass: password,
    });

    res.send(
      `✅ Approved\nUser créé: ${username}\nProfile: ${profile}\nMAC: ${mac}\n\n➡️ Raha mbola tsy tafiditra ilay client: sokafy fotsiny ny navigateur dia hiditra ho azy (mac-cookie).`
    );
  } catch (e) {
    console.error(e);
    REQS.set(token, { ...data, state: "ERROR", error: String(e.message || e) });
    res.status(500).send(`❌ Error MikroTik: ${String(e.message || e)}`);
  }
});

app.get("/deny", (req, res) => {
  const token = req.query.token;
  const data = REQS.get(token);
  if (!data) return res.status(404).send("Token inconnu");
  REQS.set(token, { ...data, state: "DENIED" });
  res.send("❌ Refusé");
});

// Demo: tsindry fotsiny -> mandefa demande any Telegram
app.get("/demo-request", async (req, res) => {
  try {
    const profile = req.query.profile || "1h";
    const mac = req.query.mac || "AA:BB:CC:DD:EE:FF";
    const ip = req.query.ip || "11.11.11.50";

    const token = makeToken();
    REQS.set(token, { state: "PENDING", mac, ip, profile });

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const approveUrl = `${baseUrl}/approve?token=${token}`;
    const denyUrl = `${baseUrl}/deny?token=${token}`;

    await bot.sendMessage(
      ADMIN_CHAT_ID,
      `🔔 DEMO Demande accès Hotspot\nMAC: ${mac}\nIP: ${ip}\nProfil: ${profile}\n\n✅ OK: ${approveUrl}\n❌ Refuse: ${denyUrl}`
    );

    res.send(`DEMO sent. Token=${token}`);
  } catch (e) {
    console.error(e);
    res.status(500).send("demo error");
  }
});

// Start server (LAST)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
