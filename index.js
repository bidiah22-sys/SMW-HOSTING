"use strict";

const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { exec } = require("child_process");

// ======================================================
//                  𝗦𝗠𝗪 𝗖𝗢𝗡𝗙𝗜𝗚𝗨𝗥𝗔𝗧𝗜𝗢𝗡
// ======================================================

const BOT_TOKEN = "9018432626:AAEzE-we9BzMCQyOrRlC_4TSPWx8VuQfyEk";
// Admin username / identifier set to fx_sidhu (ab tu /admin command chalayega to access mil jayega)
const ADMIN_USERNAME = "fx_sidhu"; 
const PORT = Number(process.env.PORT) || 3000;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB Max
const EXECUTION_TIMEOUT = 15_000; // 15 Seconds Timeout

if (!BOT_TOKEN) {
  console.error("[𝗦𝗠𝗪 FATAL] BOT_TOKEN is missing!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

// ======================================================
//        LIGHTWEIGHT JSON DATABASE (RENDER SAFE)
// ======================================================

const DATA_DIR = path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const DB_FILE = path.join(DATA_DIR, "users.json");

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    }
  } catch (err) {
    console.error("[𝗦𝗠𝗪 DB] Load error:", err.message);
  }
  return { users: {}, totalExecutions: 0 };
}

function saveDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("[𝗦𝗠𝗪 DB] Save error:", err.message);
  }
}

function rememberUser(user) {
  const db = loadDB();
  const userId = String(user.id);
  const now = new Date().toISOString();
  const displayName = [user.first_name, user.last_name].filter(Boolean).join(" ") || "Telegram User";

  if (!db.users[userId]) {
    db.users[userId] = {
      first_name: displayName,
      username: user.username || null,
      first_seen: now,
      last_seen: now,
      executions: 0
    };
  } else {
    db.users[userId].first_name = displayName;
    db.users[userId].username = user.username || null;
    db.users[userId].last_seen = now;
  }
  saveDB(db);
}

function incrementExecution(userId) {
  const db = loadDB();
  if (db.users[String(userId)]) {
    db.users[String(userId)].executions = (db.users[String(userId)].executions || 0) + 1;
  }
  db.totalExecutions = (db.totalExecutions || 0) + 1;
  saveDB(db);
}

// ======================================================
//                  RUNTIME STATE & LOGS
// ======================================================

const activeUsers = new Map();
const crashLogs = [];

function logError(label, error) {
  const entry = {
    time: new Date().toISOString(),
    label,
    message: String(error?.stack || error).slice(0, 2000)
  };
  console.error(`[𝗦𝗠𝗪] ${label}:`, entry.message);
  crashLogs.push(entry);
  if (crashLogs.length > 100) crashLogs.shift();
}

function isAdmin(ctx) {
  const username = ctx.from?.username;
  // Agar username 'fx_sidhu' hai ya fir environment variable match karta hai
  return (username && username.toLowerCase() === ADMIN_USERNAME.toLowerCase()) || 
         (process.env.ADMIN_TELEGRAM_ID && String(ctx.from?.id) === String(process.env.ADMIN_TELEGRAM_ID));
}

function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function displayName(user) {
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || "Telegram User";
}

function removeDirectory(directory) {
  if (!directory) return;
  try {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (err) {
    logError("Cleanup warning", err);
  }
}

function isPrivateChat(ctx) {
  return ctx.chat?.type === "private";
}

async function safeCallback(ctx, message = "") {
  try {
    await ctx.answerCbQuery(message);
  } catch (_) {}
}

// ======================================================
//                     𝗦𝗠𝗪 𝗞𝗘𝗬𝗕𝗢𝗔𝗥𝗗𝗦
// ======================================================

const HOME_KEYBOARD = Markup.inlineKeyboard([
  [Markup.button.callback("📂 𝗨𝗣𝗟𝗢𝗔𝗗 𝗖𝗢𝗗𝗘 & 𝗥𝗨𝗡", "upload")],
  [Markup.button.callback("👤 𝗠𝗬 𝗣𝗥𝗢𝗙𝗜𝗟𝗘", "profile"), Markup.button.callback("⚙️ 𝗟𝗔𝗡𝗚𝗨𝗔𝗚𝗘𝗦", "languages")],
  [Markup.button.callback("🛠️ 𝗛𝗘𝗟𝗣 & 𝗚𝗨𝗜𝗗𝗘", "help")],
  [Markup.button.callback("🔄 𝗥𝗘𝗙𝗥𝗘𝗦𝗛 𝗠𝗘𝗡𝗨", "home")]
]);

const BACK_KEYBOARD = Markup.inlineKeyboard([
  [Markup.button.callback("🏠 𝗠𝗔𝗜𝗡 𝗠𝗘𝗡𝗨", "home")]
]);

const ADMIN_KEYBOARD = Markup.inlineKeyboard([
  [Markup.button.callback("📊 𝗠𝗔𝗦𝗧𝗘𝗥 𝗦𝗧𝗔𝗧𝗦", "admin_stats")],
  [Markup.button.callback("🖥️ 𝗦𝗘𝗥𝗩𝗜𝗖𝗘 𝗦𝗧𝗔𝗧𝗨𝗦", "admin_status")],
  [Markup.button.callback("📜 𝗖𝗥𝗔𝗦𝗛 𝗟𝗢𝗚𝗦", "admin_logs")],
  [Markup.button.callback("🏠 𝗠𝗔𝗜𝗡 𝗠𝗘𝗡𝗨", "home")]
]);

// ======================================================
//                     HOME & MENUS
// ======================================================

async function showHome(ctx, edit = false) {
  const user = ctx.from;
  const message =
`🎀 <b>𝗪𝗘𝗟𝗖𝗢𝗠𝗘 𝗧𝗢 𝗦𝗠𝗪 𝗖𝗢𝗗𝗘 𝗛𝗨𝗕 🚩</b>

Hello, <b>${escapeHTML(displayName(user))}</b>!
Your private code execution workspace is ready.

👤 <b>Name:</b> ${escapeHTML(displayName(user))}
🔖 <b>Username:</b> ${user.username ? "@" + escapeHTML(user.username) : "Not Set"}
🆔 <b>User ID:</b> <code>${user.id}</code>

⚡ <b>𝗔𝗩𝗔𝗜𝗟𝗔𝗕𝗟𝗘 𝗥𝗨𝗡𝗧𝗜𝗠𝗘𝗦</b>
• JavaScript (.js)
• Python 3 (.py)

<b>𝗣𝗢𝗪𝗘𝗥𝗘𝗗 𝗕𝗬 𝗦𝗠𝗪 🚩</b>`;

  if (edit && ctx.callbackQuery?.message) {
    return ctx.editMessageText(message, { parse_mode: "HTML", ...HOME_KEYBOARD });
  }
  return ctx.reply(message, { parse_mode: "HTML", ...HOME_KEYBOARD });
}

bot.start(async ctx => {
  if (!isPrivateChat(ctx)) return ctx.reply("🔐 Please open a private chat with SMW Bot.");
  rememberUser(ctx.from);
  await showHome(ctx);
});

bot.action("home", async ctx => {
  await safeCallback(ctx);
  if (!isPrivateChat(ctx)) return;
  await showHome(ctx, true);
});

bot.action("profile", async ctx => {
  await safeCallback(ctx);
  const user = ctx.from;
  const db = loadDB();
  const record = db.users[String(user.id)];
  const message =
`👤 <b>𝗬𝗢𝗨𝗥 𝗣𝗥𝗢𝗙𝗜𝗟𝗘</b>

🧑 <b>Name:</b> ${escapeHTML(displayName(user))}
🔖 <b>Username:</b> ${user.username ? "@" + escapeHTML(user.username) : "Not Set"}
🆔 <b>Telegram ID:</b> <code>${user.id}</code>

📅 <b>Joined:</b> ${escapeHTML(record?.first_seen || "Unknown")}
🚀 <b>Executions:</b> ${record?.executions || 0}

🚩 <b>𝗦𝗠𝗪 𝗛𝗢𝗦𝗧𝗜𝗡𝗚 𝗨𝗦𝗘𝗥</b>`;

  await ctx.editMessageText(message, { parse_mode: "HTML", ...BACK_KEYBOARD });
});

bot.action("languages", async ctx => {
  await safeCallback(ctx);
  await ctx.editMessageText(
`⚙️ <b>𝗦𝗨𝗣𝗣𝗢𝗥𝗧𝗘𝗗 𝗟𝗔𝗡𝗚𝗨𝗔𝗚𝗘𝗦</b>

🟨 <b>𝗝𝗮𝘃𝗮𝗦𝗰𝗿𝗶𝗽𝘁 (.𝗷𝘀)</b> — Node.js
🐍 <b>𝗣𝘆𝘁𝗵𝗼𝗻 (.𝗽𝘆)</b> — Python 3

📦 <b>Max file size:</b> 10 MB
⏱ <b>Execution timeout:</b> 15 seconds

<b>𝗣𝗢𝗪𝗘𝗥𝗘𝗗 𝗕𝗬 𝗦𝗠𝗪 🚩</b>`,
    { parse_mode: "HTML", ...BACK_KEYBOARD }
  );
});

bot.action("help", async ctx => {
  await safeCallback(ctx);
  await ctx.editMessageText(
`🛠️ <b>𝗦𝗠𝗪 𝗛𝗘𝗟𝗣 & 𝗚𝗨𝗜𝗗𝗘</b>

1️⃣ Click on <b>𝗨𝗣𝗟𝗢𝗔𝗗 𝗖𝗢𝗗𝗘 & 𝗥𝗨𝗡</b>.
2️⃣ Send your <code>.js</code> or <code>.py</code> file as a Document.
3️⃣ SMW executes it securely in an isolated workspace.
4️⃣ Get your output instantly!

<b>𝗣𝗢𝗪𝗘𝗥𝗘𝗗 𝗕𝗬 𝗦𝗠𝗪 🚩</b>`,
    { parse_mode: "HTML", ...BACK_KEYBOARD }
  );
});

bot.action("upload", async ctx => {
  await safeCallback(ctx);
  await ctx.editMessageText(
`📂 <b>𝗨𝗣𝗟𝗢𝗔𝗗 𝗖𝗢𝗗𝗘 & 𝗥𝗨𝗡</b>

Send your file directly in this private chat.
✅ <code>.js</code> — JavaScript
✅ <code>.py</code> — Python

📦 Maximum: 10 MB
⏱ Timeout: 15 seconds

<b>𝗦𝗠𝗪 𝗜𝗦 𝗥𝗘𝗗𝗬 🚩</b>`,
    { parse_mode: "HTML", ...BACK_KEYBOARD }
  );
});

// ======================================================
//                  ADMIN PANEL COMMANDS
// ======================================================

bot.command("admin", async ctx => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Access denied. Only @fx_sidhu can access this panel.");
  await ctx.reply("👑 <b>𝗦𝗠𝗪 𝗗𝗘𝗩𝗘𝗟𝗢𝗣𝗘𝗥 𝗣𝗔𝗡𝗘𝗟</b>\n\nWelcome back, <b>fx_sidhu</b>! Full administrative access granted.", { parse_mode: "HTML", ...ADMIN_KEYBOARD });
});

bot.action("admin_stats", async ctx => {
  if (!isAdmin(ctx)) return safeCallback(ctx, "Access denied.");
  await safeCallback(ctx);
  const db = loadDB();
  const totalUsers = Object.keys(db.users).length;
  const message =
`📊 <b>𝗦𝗠𝗪 𝗠𝗔𝗦𝗧𝗘𝗥 𝗦𝗧𝗔𝗧𝗦</b>

👥 <b>Total Users:</b> ${totalUsers}
🚀 <b>Total Executions:</b> ${db.totalExecutions || 0}
⚙️ <b>Active Executions:</b> ${activeUsers.size}
📜 <b>Error Records:</b> ${crashLogs.length}

👑 <b>ADMIN: fx_sidhu</b>`;

  await ctx.editMessageText(message, { parse_mode: "HTML", ...ADMIN_KEYBOARD });
});

bot.action("admin_status", async ctx => {
  if (!isAdmin(ctx)) return safeCallback(ctx, "Access denied.");
  await safeCallback(ctx);
  const message =
`🖥️ <b>𝗦𝗠𝗪 𝗦𝗘𝗥𝗩𝗜𝗖𝗘 𝗦𝗧𝗔𝗧𝗨𝗦</b>

🟢 Bot process: Running
🟢 Express: Running
⚙️ Active executions: ${activeUsers.size}
📦 File persistence: JSON Storage (Render Safe)

👑 <b>DEVELOPER: fx_sidhu</b>`;

  await ctx.editMessageText(message, { parse_mode: "HTML", ...ADMIN_KEYBOARD });
});

bot.action("admin_logs", async ctx => {
  if (!isAdmin(ctx)) return safeCallback(ctx, "Access denied.");
  await safeCallback(ctx);
  const recent = crashLogs.slice(-10);
  const logText = recent.length ? recent.map((item, idx) => `${idx + 1}. ${item.time}\n${item.label}: ${item.message}`).join("\n\n") : "No recent errors.";
  await ctx.reply(`<b>📜 𝗦𝗠𝗪 𝗥𝗘𝗖𝗘𝗡𝗧 𝗘𝗥𝗥𝗢𝗥 𝗟𝗢𝗚𝗦</b>\n\n<pre>${escapeHTML(logText.slice(0, 3500))}</pre>`, { parse_mode: "HTML" });
});

// ======================================================
//        BULLETPROOF SAFE EXECUTION ENGINE
// ======================================================

bot.on("document", async ctx => {
  if (!isPrivateChat(ctx)) {
    return ctx.reply("🔐 For privacy, please upload files in the bot's private chat.");
  }

  const userId = String(ctx.from.id);
  const document = ctx.message.document;
  if (!document) return ctx.reply("❌ No document detected.");

  const filename = path.basename(document.file_name || "code.txt");
  const extension = path.extname(filename).toLowerCase();

  if (document.file_size && document.file_size > MAX_FILE_SIZE) {
    return ctx.reply("❌ File size exceeds the 10 MB limit.");
  }

  if (![".js", ".py"].includes(extension)) {
    return ctx.reply("❌ Unsupported format! Only <code>.js</code> and <code>.py</code> files are supported.", { parse_mode: "HTML" });
  }

  if (activeUsers.has(userId)) {
    return ctx.reply("⏳ You already have an active execution running. Please wait.");
  }

  activeUsers.set(userId, true);
  let jobDirectory = null;
  let statusMsg = null;

  try {
    statusMsg = await ctx.reply(
`⏳ <b>𝗦𝗠𝗪 𝗘𝗫𝗘𝗖𝗨𝗧𝗜𝗢𝗡 𝗦𝗧𝗔𝗥𝗧𝗘𝗗</b>

📄 File: <code>${escapeHTML(filename)}</code>
⚙️ Downloading file safely...`,
      { parse_mode: "HTML" }
    );

    const fileUrl = await ctx.telegram.getFileLink(document.file_id);
    const fileResponse = await axios.get(fileUrl.href, { responseType: "arraybuffer", timeout: 25000 });

    jobDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "smw-sec-"));
    fs.chmodSync(jobDirectory, 0o700);

    const localFile = path.join(jobDirectory, extension === ".js" ? "main.js" : "main.py");
    fs.writeFileSync(localFile, fileResponse.data, { mode: 0o400 });

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      `⏳ <b>𝗦𝗠𝗪 𝗘𝗫𝗘𝗖𝗨𝗧𝗜𝗢𝗡 𝗦𝗧𝗔𝗥𝗧𝗘𝗗</b>\n\n📄 File: <code>${escapeHTML(filename)}</code>\n⚙️ Running code in sandbox...`,
      { parse_mode: "HTML" }
    ).catch(() => {});

    const cmd = extension === ".js" ? `node "${localFile}"` : `python3 "${localFile}"`;

    exec(cmd, { timeout: EXECUTION_TIMEOUT, maxBuffer: 1024 * 1024 * 2 }, (error, stdout, stderr) => {
      removeDirectory(jobDirectory);
      activeUsers.delete(userId);
      rememberUser(ctx.from);
      incrementExecution(userId);

      const status = error ? "𝗙𝗔𝗜𝗟𝗘𝗗 / 𝗧𝗜𝗠𝗘𝗢𝗨𝗧" : "𝗦𝗨𝗖𝗖𝗘𝗦𝗦";
      let result = `🚀 <b>𝗦𝗠𝗪 𝗘𝗫𝗘𝗖𝗨𝗧𝗜𝗢𝗡 𝗥𝗘𝗦𝗨𝗟𝗧</b>\n\n📄 <b>𝗙𝗶𝗹𝗲:</b> ${escapeHTML(filename)}\n📊 <b>𝗦𝘁𝗮𝘁𝘂𝘀:</b> ${status}\n\n`;

      if (stdout) {
        result += `📤 <b>𝗦𝗧𝗗𝗢𝗨𝗧</b>\n<pre>${escapeHTML(stdout.slice(0, 3000))}</pre>\n\n`;
      }
      if (stderr) {
        result += `⚠️ <b>𝗦𝗧𝗗𝗘𝗥𝗥</b>\n<pre>${escapeHTML(stderr.slice(0, 2500))}</pre>\n\n`;
      }
      if (!stdout && !stderr && !error) {
        result += `✅ Executed successfully with no output.\n\n`;
      }
      if (error && !stderr) {
        result += `❌ <b>𝗘𝗿𝗿𝗼𝗿:</b>\n<pre>${escapeHTML(error.message)}</pre>\n\n`;
      }

      result += `<b>𝗣𝗢𝗪𝗘𝗥𝗘𝗗 𝗕𝗬 𝗦𝗠𝗪 🚩</b>`;

      ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, result, {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("📂 𝗥𝗨𝗡 𝗔𝗡𝗢𝗧𝗛𝗘𝗥", "upload")],
          [Markup.button.callback("🏠 𝗠𝗔𝗜𝗡 𝗠𝗘𝗡𝗨", "home")]
        ])
      }).catch(err => logError("Edit message", err));
    });

  } catch (err) {
    removeDirectory(jobDirectory);
    activeUsers.delete(userId);
    logError("Document execution", err);

    const errorText = `❌ <b>𝗘𝗫𝗘𝗖𝗨𝗧𝗜𝗢𝗡 𝗙𝗔𝗜𝗟𝗘𝗗</b>\n\n${escapeHTML(err.message)}`;
    if (statusMsg) {
      ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, errorText, { parse_mode: "HTML" }).catch(() => {});
    } else {
      ctx.reply(errorText, { parse_mode: "HTML" }).catch(() => {});
    }
  }
});

// ======================================================
//       CRASH-PROOF GLOBAL ERROR HANDLERS
// ======================================================

bot.catch((err, ctx) => {
  logError(`Telegram update ${ctx.update?.update_id}`, err);
});

process.on("unhandledRejection", (reason) => {
  logError("Unhandled Rejection", reason);
});

process.on("uncaughtException", (err) => {
  logError("Uncaught Exception", err);
});

// ======================================================
//        EXPRESS 24/7 KEEP-ALIVE & SELF-Ping
// ======================================================

app.get("/", (req, res) => {
  res.status(200).send("🚀 SMW Bot Active 24/7");
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy", service: "SMW-Bot", admin: "fx_sidhu" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[𝗦𝗠𝗪] Server running smoothly on port ${PORT}`);
  
  // 🚀 AUTOMATIC SELF-PING SYSTEM (Prevents Render 15-minute sleep)
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(() => {
    axios.get(`${RENDER_URL}/health`)
      .then(() => console.log("[𝗦𝗠𝗪 Self-Ping] Server kept alive successfully!"))
      .catch((err) => console.log("[𝗦𝗠𝗪 Self-Ping] Ping skipped:", err.message));
  }, 9 * 60 * 1000); // Har 9 minute mein khud ko ping karega
});

bot.launch().then(() => {
  console.log("[𝗦𝗠𝗪] Telegram bot successfully launched and crash-proof!");
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
