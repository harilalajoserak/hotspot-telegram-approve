import express from "express";
import TelegramBot from "node-telegram-bot-api";

const app = express();
app.use(express.json());

// ENV variables (hapetraka ao Render)
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

const bot = new TelegramBot(BOT_TOKEN);

// Page test
app.get("/", (req, res) => {
  res.send("Server OK");
});

// Test Telegram
app.get("/test", async (req, res) => {
  await bot.sendMessage(
    ADMIN_CHAT_ID,
    "🔔 TEST OK : Render → Telegram fonctionne"
  );
  res.json({ status: "sent" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
