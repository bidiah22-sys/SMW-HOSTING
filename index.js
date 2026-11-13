"use strict";

/*
 * ╔══════════════════════════════════════════════╗
 * ║             SMW HOSTING 🚩                   ║
 * ║       Telegram Hosting Management Bot       ║
 * ╚══════════════════════════════════════════════╝
 *
 * Node.js 20+
 * Render Web Service
 */

const { Telegraf, Markup } = require("telegraf");
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { exec, spawn } = require("child_process");

// =================================================
// CONFIGURATION
// =================================================

const BOT_TOKEN = "9018432626:AAEzE-we9BzMCQyOrRlC_4TSPWx8VuQfyEk";

const ADMIN_USERNAME = "fx_sidhu";
const ADMIN_TELEGRAM_ID = Number(process.env.ADMIN_TELEGRAM_ID || 0);

const PORT = Number(process.env.PORT) || 3000;
const MAX_FILE_SIZE = 15 * 1024 * 1024;

const DATA_DIR = path.join(__dirname, "data");
const PROJECT_DIR = path.join(__dirname, "projects");
const RUNNING_DIR = path.join(__dirname, "running");

const DB_FILE = path.join(DATA_DIR, "database.json");

const app = express();

app.use(express.json({ limit: "32kb" }));

if (
    !BOT_TOKEN ||
    BOT_TOKEN === "PASTE_YOUR_NEW_BOT_TOKEN_HERE"
) {
    console.error("SMW HOSTING: Add your new BOT_TOKEN in index.js");
    process.exit(1);
}

// =================================================
// DIRECTORIES
// =================================================

for (const dir of [DATA_DIR, PROJECT_DIR, RUNNING_DIR]) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
}

// =================================================
// DATABASE
// =================================================

function defaultDatabase() {
    return {
        users: {},
        projects: {},
        activeProcesses: {},
        executions: 0,
        startedAt: new Date().toISOString()
    };
}

function loadDatabase() {
    try {
        if (!fs.existsSync(DB_FILE)) {
            return defaultDatabase();
        }

        const data = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));

        return {
            ...defaultDatabase(),
            ...data
        };
    } catch (error) {
        console.error("Database read error:", error.message);
        return defaultDatabase();
    }
}

let db = loadDatabase();

let saveQueue = Promise.resolve();

function saveDatabase() {
    const snapshot = JSON.stringify(db, null, 2);

    saveQueue = saveQueue
        .then(async () => {
            const tempFile = DB_FILE + ".tmp";
            await fs.promises.writeFile(tempFile, snapshot);
            await fs.promises.rename(tempFile, DB_FILE);
        })
        .catch(error => {
            console.error("Database save error:", error.message);
        });

    return saveQueue;
}

// =================================================
// BOT
// =================================================

const bot = new Telegraf(BOT_TOKEN);

const activeUsers = new Map();
const activeProcesses = new Map();
const crashLogs = [];

let botStartedAt = Date.now();
let botReady = false;

function logError(error) {
    const entry = {
        time: new Date().toISOString(),
        message: String(error?.stack || error)
    };

    crashLogs.unshift(entry);

    if (crashLogs.length > 100) {
        crashLogs.pop();
    }

    console.error(entry.message);
}

function smw(text) {
    return text;
}

function isAdmin(ctx) {
    const user = ctx.from;

    if (!user) return false;

    const username = String(user.username || "").toLowerCase();

    return (
        username === ADMIN_USERNAME.toLowerCase() ||
        (ADMIN_TELEGRAM_ID !== 0 &&
            Number(user.id) === ADMIN_TELEGRAM_ID)
    );
}

function getUser(ctx) {
    const id = String(ctx.from.id);

    if (!db.users[id]) {
        db.users[id] = {
            id: ctx.from.id,
            username: ctx.from.username || "",
            firstName: ctx.from.first_name || "",
            language: ctx.from.language_code || "unknown",
            joinedAt: new Date().toISOString(),
            uploads: 0,
            projects: [],
            lastSeen: new Date().toISOString()
        };
    }

    const user = db.users[id];

    user.username = ctx.from.username || user.username;
    user.firstName = ctx.from.first_name || user.firstName;
    user.lastSeen = new Date().toISOString();

    return user;
}

function userProjects(userId) {
    return Object.values(db.projects).filter(
        project => String(project.ownerId) === String(userId)
    );
}

function projectStatus(project) {
    return project.status || "ANALYSIS_PENDING";
}

// =================================================
// KEYBOARDS (ORIGINAL STYLISH SETUP)
// =================================================

function mainMenu(admin = false) {
    const rows = [
        [
            Markup.button.callback("📤 UPLOAD PROJECT", "upload"),
            Markup.button.callback("📁 MY PROJECTS", "myprojects")
        ],
        [
            Markup.button.callback("👤 MY PROFILE", "profile"),
            Markup.button.callback("💻 LANGUAGES", "languages")
        ],
        [
            Markup.button.callback("📖 HELP & GUIDE", "help"),
            Markup.button.callback("🔄 REFRESH", "home")
        ]
    ];

    if (admin) {
        rows.push([
            Markup.button.callback("👑 DEVELOPER PANEL", "admin")
        ]);
    }

    return Markup.inlineKeyboard(rows);
}

function adminMenu() {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback("📊 MASTER STATS", "admin_stats"),
            Markup.button.callback("🖥 SERVICE STATUS", "admin_status")
        ],
        [
            Markup.button.callback("👥 ALL USERS", "admin_users"),
            Markup.button.callback("📁 ALL PROJECTS", "admin_projects")
        ],
        [
            Markup.button.callback("📜 CRASH LOGS", "admin_logs"),
            Markup.button.callback("🔄 REFRESH", "admin")
        ],
        [
            Markup.button.callback("🏠 HOME", "home")
        ]
    ]);
}

function backButton(target = "home") {
    return Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ BACK", target)]
    ]);
}

// =================================================
// HOME
// =================================================

async function showHome(ctx, edit = false) {
    const user = getUser(ctx);
    await saveDatabase();

    const admin = isAdmin(ctx);

    const message =
        "🎀 SMW HOSTING 🚩\n\n" +
        "Welcome to SMW Hosting Management.\n\n" +
        `👤 User: ${user.firstName || "User"}\n` +
        `🆔 ID: ${user.id}\n` +
        `📁 Your Projects: ${userProjects(user.id).length}\n\n` +
        "Select an option below.";

    if (edit && ctx.callbackQuery) {
        return ctx.editMessageText(
            message,
            mainMenu(admin)
        ).catch(() => ctx.reply(message, mainMenu(admin)));
    }

    return ctx.reply(message, mainMenu(admin));
}

bot.start(async ctx => {
    try {
        await showHome(ctx);
    } catch (error) {
        logError(error);
        await ctx.reply("SMW HOSTING: Unable to open menu.");
    }
});

bot.action("home", async ctx => {
    await ctx.answerCbQuery();
    await showHome(ctx, true);
});

// =================================================
// PROFILE
// =================================================

bot.action("profile", async ctx => {
    await ctx.answerCbQuery();

    const user = getUser(ctx);
    const projects = userProjects(user.id);

    const message =
        "👤 MY PROFILE\n\n" +
        `Name: ${user.firstName || "Not available"}\n` +
        `Username: @${user.username || "Not set"}\n` +
        `Telegram ID: ${user.id}\n` +
        `Language: ${user.language}\n` +
        `Joined: ${user.joinedAt}\n` +
        `Total Uploads: ${user.uploads}\n` +
        `My Projects: ${projects.length}`;

    await ctx.editMessageText(message, backButton());
});

// =================================================
// LANGUAGES
// =================================================

bot.action("languages", async ctx => {
    await ctx.answerCbQuery();

    await ctx.editMessageText(
        "💻 SUPPORTED PROJECT TYPES\n\n" +
        "🟢 Node.js — package.json detection & Auto npm install\n" +
        "🟢 Python — requirements.txt detection & Auto pip install\n" +
        "🟢 Python — pyproject.toml detection\n" +
        "🟢 Static Website — HTML/CSS/JS detection\n" +
        "🟡 ZIP — project archive inspection & hosting\n\n" +
        "⚡ Powered by SMW Live Execution Engine 🚩",
        backButton()
    );
});

// =================================================
// HELP
// =================================================

bot.action("help", async ctx => {
    await ctx.answerCbQuery();

    await ctx.editMessageText(
        "📖 SMW HOSTING — HELP CENTER\n\n" +
        "1. Select UPLOAD PROJECT.\n" +
        "2. Send your project file.\n" +
        "3. The bot downloads and inspects the file.\n" +
        "4. Project type and configuration are detected.\n" +
        "5. Dependencies are installed automatically.\n" +
        "6. Check and manage your live project in MY PROJECTS.\n\n" +
        "Maximum upload size: 15 MB.",
        backButton()
    );
});

// =================================================
// UPLOAD & LIVE HOSTING ENGINE
// =================================================

bot.action("upload", async ctx => {
    await ctx.answerCbQuery();

    activeUsers.set(ctx.from.id, {
        mode: "waiting_for_project"
    });

    await ctx.editMessageText(
        "📤 PROJECT UPLOAD & AUTO-HOSTING\n\n" +
        "Send your project file as a Telegram document.\n\n" +
        "Maximum size: 15 MB\n" +
        "Supported: JS, Python, HTML, ZIP, etc.\n\n" +
        "The bot will automatically inspect, install requirements, and host it live 24/7!",
        backButton()
    );
});

function detectProjectType(filename) {
    const lower = filename.toLowerCase();

    if (lower.endsWith(".zip")) return "ZIP ARCHIVE";
    if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "NODE.JS";
    if (lower.endsWith(".py")) return "PYTHON";
    if (lower.endsWith(".html") || lower.endsWith(".htm")) return "STATIC WEBSITE";
    if (lower.endsWith(".json")) return "JSON FILE";
    if (lower.endsWith(".css")) return "CSS FILE";

    return "UNKNOWN FILE TYPE";
}

async function downloadTelegramFile(fileId, destination) {
    const fileInfo = await bot.telegram.getFile(fileId);

    if (!fileInfo.file_path) {
        throw new Error("Telegram file path unavailable.");
    }

    const url =
        `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;

    const response = await axios.get(url, {
        responseType: "stream",
        timeout: 60000,
        maxContentLength: MAX_FILE_SIZE
    });

    const contentLength = Number(response.headers["content-length"] || 0);

    if (contentLength > MAX_FILE_SIZE) {
        response.data.destroy();
        throw new Error("File exceeds 15 MB limit.");
    }

    let received = 0;

    await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(destination);

        response.data.on("data", chunk => {
            received += chunk.length;

            if (received > MAX_FILE_SIZE) {
                response.data.destroy(
                    new Error("File exceeds 15 MB limit.")
                );
            }
        });

        response.data.on("error", reject);
        output.on("error", reject);
        output.on("finish", resolve);

        response.data.pipe(output);
    });

    return received;
}

async function inspectProject(filePath, filename) {
    const result = {
        type: detectProjectType(filename),
        filename,
        detectedFiles: [],
        requirements: [],
        startupCommand: null,
        status: "ANALYSIS_PENDING"
    };

    if (filename.toLowerCase() === "package.json") {
        const content = await fs.promises.readFile(filePath, "utf8");
        const pkg = JSON.parse(content);

        result.detectedFiles.push("package.json");
        result.requirements = Object.keys(pkg.dependencies || {});
        result.startupCommand = pkg.scripts?.start || pkg.main || null;
        result.status = "CONFIGURATION_DETECTED";
    }

    if (filename.toLowerCase() === "requirements.txt") {
        const content = await fs.promises.readFile(filePath, "utf8");

        result.detectedFiles.push("requirements.txt");
        result.requirements = content
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line && !line.startsWith("#"));

        result.status = "CONFIGURATION_DETECTED";
    }

    if (filename.toLowerCase() === "pyproject.toml") {
        result.detectedFiles.push("pyproject.toml");
        result.status = "CONFIGURATION_DETECTED";
    }

    if (filename.toLowerCase() === "index.html") {
        result.detectedFiles.push("index.html");
        result.status = "STATIC_PROJECT_DETECTED";
    }

    return result;
}

// Live Deployment & Execution Logic
async function deployLiveProject(projectId, filePath, filename) {
    const projectFolder = path.join(RUNNING_DIR, projectId);
    fs.mkdirSync(projectFolder, { recursive: true });

    const ext = path.extname(filename).toLowerCase();
    let mainFile = filename;

    if (ext === ".zip") {
        fs.copyFileSync(filePath, path.join(projectFolder, filename));
    } else {
        mainFile = "main" + ext;
        fs.copyFileSync(filePath, path.join(projectFolder, mainFile));
    }

    let startupCommand = "";

    if (ext === ".js" || filename === "package.json") {
        startupCommand = `node ${mainFile}`;
        if (fs.existsSync(path.join(projectFolder, "package.json"))) {
            await new Promise(res => exec("npm install", { cwd: projectFolder }, res));
        }
    } else if (ext === ".py") {
        startupCommand = `python3 ${mainFile}`;
        if (fs.existsSync(path.join(projectFolder, "requirements.txt"))) {
            await new Promise(res => exec("pip install -r requirements.txt", { cwd: projectFolder }, res));
        }
    }

    if (startupCommand) {
        const child = spawn(startupCommand, { cwd: projectFolder, shell: true });
        activeProcesses.set(projectId, child);

        child.stdout.on("data", (data) => {
            console.log(`[PROJ ${projectId}]`, data.toString());
        });

        child.stderr.on("data", (data) => {
            console.error(`[PROJ ${projectId} ERR]`, data.toString());
        });

        child.on("close", (code) => {
            if (db.projects[projectId]) {
                db.projects[projectId].status = `STOPPED (${code})`;
                saveDatabase();
            }
        });
    }

    return startupCommand;
}

bot.on("document", async ctx => {
    const user = getUser(ctx);
    const state = activeUsers.get(ctx.from.id);

    if (!state || state.mode !== "waiting_for_project") {
        return ctx.reply(
            "Please open UPLOAD PROJECT before sending a file.",
            mainMenu(isAdmin(ctx))
        );
    }

    const document = ctx.message.document;
    const filename = path.basename(document.file_name || "upload.bin");

    if (document.file_size && document.file_size > MAX_FILE_SIZE) {
        return ctx.reply("❌ File too large. Maximum allowed size is 15 MB.");
    }

    const projectId = crypto.randomBytes(5).toString("hex");
    const userFolder = path.join(PROJECT_DIR, String(ctx.from.id));

    await fs.promises.mkdir(userFolder, { recursive: true });

    const destination = path.join(userFolder, projectId + "_" + filename);

    const statusMessage = await ctx.reply(
        "⏳ UPLOAD STARTED\n\n" +
        "Please wait while SMW Hosting receives your file..."
    );

    try {
        await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMessage.message_id,
            undefined,
            "⏳ DOWNLOADING FILE...\n\nPlease wait."
        );

        const received = await downloadTelegramFile(
            document.file_id,
            destination
        );

        await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMessage.message_id,
            undefined,
            "✅ UPLOAD COMPLETE: 100%\n\n🔍 Inspecting and deploying live..."
        );

        const inspection = await inspectProject(destination, filename);
        const startupCommand = await deployLiveProject(projectId, destination, filename);

        const project = {
            id: projectId,
            ownerId: ctx.from.id,
            ownerUsername: ctx.from.username || "",
            filename,
            filePath: path.relative(__dirname, destination),
            size: received,
            type: inspection.type,
            requirements: inspection.requirements,
            detectedFiles: inspection.detectedFiles,
            startupCommand: startupCommand || inspection.startupCommand,
            status: "RUNNING 24/7",
            createdAt: new Date().toISOString(),
            logs: [
                {
                    time: new Date().toISOString(),
                    message: "File uploaded, dependencies installed, and project hosted live."
                }
            ]
        };

        db.projects[projectId] = project;
        user.uploads = Number(user.uploads || 0) + 1;
        user.projects.push(projectId);

        await saveDatabase();

        activeUsers.delete(ctx.from.id);

        const requirements =
            inspection.requirements.length
                ? inspection.requirements.join(", ")
                : "No dependencies detected";

        await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMessage.message_id,
            undefined,
            "🎀 SMW HOSTING — LIVE DEPLOYMENT REPORT 🚩\n\n" +
            "✅ Upload & Host: 100% Complete\n" +
            `📁 File: ${filename}\n` +
            `🆔 Project ID: ${projectId}\n` +
            `📦 Size: ${(received / 1024).toFixed(2)} KB\n` +
            `💻 Type: ${inspection.type}\n` +
            `🚀 Status: ONLINE & RUNNING 24/7\n\n` +
            `📚 Detected requirements:\n${requirements}\n\n` +
            "Your project is now successfully hosted on SMW Cloud!"
        );

    } catch (error) {
        logError(error);

        activeUsers.delete(ctx.from.id);

        await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMessage.message_id,
            undefined,
            "❌ DEPLOYMENT FAILED\n\n" +
            "Reason: " + error.message
        ).catch(() => {});
    }
});

// =================================================
// MY PROJECTS
// =================================================

bot.action("myprojects", async ctx => {
    await ctx.answerCbQuery();

    const projects = userProjects(ctx.from.id);

    if (!projects.length) {
        return ctx.editMessageText(
            "📁 MY PROJECTS\n\nNo projects uploaded yet.",
            backButton()
        );
    }

    const buttons = projects.map(project => [
        Markup.button.callback(
            `${project.filename} — ${project.status}`,
            `project_${project.id}`
        )
    ]);

    buttons.push([
        Markup.button.callback("⬅️ BACK", "home")
    ]);

    await ctx.editMessageText(
        "📁 MY PROJECTS\n\nSelect a project to manage:",
        Markup.inlineKeyboard(buttons)
    );
});

bot.action(/^project_([a-f0-9]+)$/, async ctx => {
    await ctx.answerCbQuery();

    const id = ctx.match[1];
    const project = db.projects[id];

    if (!project) {
        return ctx.reply("Project not found.");
    }

    if (
        String(project.ownerId) !== String(ctx.from.id) &&
        !isAdmin(ctx)
    ) {
        return ctx.reply("⛔ Access denied.");
    }

    const message =
        "📁 PROJECT DETAILS\n\n" +
        `Name: ${project.filename}\n` +
        `ID: ${project.id}\n` +
        `Type: ${project.type}\n` +
        `Status: ${projectStatus(project)}\n` +
        `Size: ${(project.size / 1024).toFixed(2)} KB\n` +
        `Created: ${project.createdAt}\n` +
        `Startup: ${project.startupCommand || "Not detected"}`;

    await ctx.editMessageText(
        message,
        Markup.inlineKeyboard([
            [
                Markup.button.callback("🛑 STOP PROJECT", `stopproj_${id}`),
                Markup.button.callback("📜 LOGS", `projectlogs_${id}`)
            ],
            [
                Markup.button.callback("⬅️ MY PROJECTS", "myprojects")
            ]
        ])
    );
});

bot.action(/^stopproj_([a-f0-9]+)$/, async ctx => {
    await ctx.answerCbQuery();
    const id = ctx.match[1];

    if (activeProcesses.has(id)) {
        activeProcesses.get(id).kill();
        activeProcesses.delete(id);
    }

    if (db.projects[id]) {
        db.projects[id].status = "STOPPED BY USER";
        await saveDatabase();
    }

    await ctx.editMessageText("🛑 Project process has been stopped.", backButton("myprojects"));
});

bot.action(/^projectlogs_([a-f0-9]+)$/, async ctx => {
    await ctx.answerCbQuery();

    const project = db.projects[ctx.match[1]];

    if (!project) return ctx.reply("Project not found.");

    if (
        String(project.ownerId) !== String(ctx.from.id) &&
        !isAdmin(ctx)
    ) {
        return ctx.reply("⛔ Access denied.");
    }

    const logs = (project.logs || [])
        .slice(-10)
        .map(log => `${log.time}\n${log.message}`)
        .join("\n\n");

    await ctx.reply(
        "📜 PROJECT LOGS\n\n" + (logs || "No logs available.")
    );
});

// =================================================
// ADMIN PANEL
// =================================================

bot.command("admin", async ctx => {
    if (!isAdmin(ctx)) {
        return ctx.reply("⛔ ADMIN ACCESS DENIED.");
    }

    await ctx.reply(
        "👑 SMW DEVELOPER CONTROL PANEL\n\nSelect a control:",
        adminMenu()
    );
});

bot.action("admin", async ctx => {
    await ctx.answerCbQuery();

    if (!isAdmin(ctx)) {
        return ctx.reply("⛔ ADMIN ACCESS DENIED.");
    }

    await ctx.editMessageText(
        "👑 SMW DEVELOPER CONTROL PANEL\n\nSelect a control:",
        adminMenu()
    );
});

bot.action("admin_stats", async ctx => {
    await ctx.answerCbQuery();

    if (!isAdmin(ctx)) return ctx.reply("⛔ Access denied.");

    const users = Object.keys(db.users).length;
    const projects = Object.keys(db.projects).length;

    await ctx.editMessageText(
        "📊 MASTER STATISTICS\n\n" +
        `👥 Total Users: ${users}\n` +
        `📁 Total Projects: ${projects}\n` +
        `📤 Total Uploads: ${db.executions}\n` +
        `🚀 Active Processes: ${activeProcesses.size}\n` +
        `🖥 Server Platform: ${process.platform}\n` +
        `🟢 Bot Ready: ${botReady ? "YES" : "NO"}\n` +
        `⏱ Uptime: ${Math.floor(process.uptime())} seconds`,
        backButton("admin")
    );
});

bot.action("admin_status", async ctx => {
    await ctx.answerCbQuery();

    if (!isAdmin(ctx)) return ctx.reply("⛔ Access denied.");

    const memory = process.memoryUsage();

    await ctx.editMessageText(
        "🖥 SERVICE STATUS\n\n" +
        `Bot: ${botReady ? "ONLINE" : "STARTING"}\n` +
        `Node: ${process.version}\n` +
        `Platform: ${process.platform}\n` +
        `CPU Cores: ${os.cpus().length}\n` +
        `System RAM: ${(os.totalmem() / 1024 / 1024).toFixed(0)} MB\n` +
        `Free RAM: ${(os.freemem() / 1024 / 1024).toFixed(0)} MB\n` +
        `Process RAM: ${(memory.rss / 1024 / 1024).toFixed(2)} MB\n` +
        `Process Uptime: ${Math.floor(process.uptime())} seconds`,
        backButton("admin")
    );
});

bot.action("admin_users", async ctx => {
    await ctx.answerCbQuery();

    if (!isAdmin(ctx)) return ctx.reply("⛔ Access denied.");

    const users = Object.values(db.users);

    const list = users.slice(0, 30).map(user =>
        `👤 ${user.firstName || "User"}\n` +
        `ID: ${user.id}\n` +
        `Username: @${user.username || "none"}`
    ).join("\n\n");

    await ctx.editMessageText(
        "👥 REGISTERED USERS\n\n" +
        (list || "No users registered."),
        backButton("admin")
    );
});

bot.action("admin_projects", async ctx => {
    await ctx.answerCbQuery();

    if (!isAdmin(ctx)) return ctx.reply("⛔ Access denied.");

    const projects = Object.values(db.projects);

    const list = projects.slice(0, 30).map(project =>
        `📁 ${project.filename}\n` +
        `ID: ${project.id}\n` +
        `Owner: ${project.ownerId}\n` +
        `Status: ${project.status}`
    ).join("\n\n");

    await ctx.editMessageText(
        "📁 ALL PROJECTS\n\n" +
        (list || "No projects available."),
        backButton("admin")
    );
});

bot.action("admin_logs", async ctx => {
    await ctx.answerCbQuery();

    if (!isAdmin(ctx)) return ctx.reply("⛔ Access denied.");

    const logs = crashLogs.slice(0, 10)
        .map(log => `${log.time}\n${log.message}`)
        .join("\n\n");

    await ctx.editMessageText(
        "📜 CRASH LOGS\n\n" +
        (logs || "No crash logs recorded."),
        backButton("admin")
    );
});

// =================================================
// COMMANDS
// =================================================

bot.command("help", async ctx => {
    await ctx.reply(
        "SMW HOSTING COMMANDS\n\n" +
        "/start - Open main menu\n" +
        "/help - Help center\n" +
        "/admin - Developer panel\n" +
        "/status - Bot status\n" +
        "/projects - Your projects"
    );
});

bot.command("status", async ctx => {
    await ctx.reply(
        `SMW HOSTING: ${botReady ? "ONLINE" : "STARTING"}\n` +
        `Uptime: ${Math.floor(process.uptime())} seconds`
    );
});

bot.command("projects", async ctx => {
    const projects = userProjects(ctx.from.id);

    await ctx.reply(
        "YOUR PROJECTS\n\n" +
        (projects.map(p => `${p.filename} — ${p.status}`).join("\n") ||
            "No projects yet.")
    );
});

// =================================================
// WEB SERVER
// =================================================

app.get("/", (req, res) => {
    res.status(200).send(
        "🎀 SMW HOSTING 🚩 — Telegram Hosting Management Bot"
    );
});

app.get("/health", (req, res) => {
    res.status(200).json({
        status: "online",
        service: "SMW HOSTING",
        botReady,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// =================================================
// RENDER SELF PING — PRESERVED
// =================================================

const SELF_URL =
    process.env.RENDER_EXTERNAL_URL ||
    `http://localhost:${PORT}`;

setInterval(async () => {
    try {
        await axios.get(`${SELF_URL}/health`, {
            timeout: 15000
        });
    } catch (error) {
        console.error("SMW self-ping error:", error.message);
    }
}, 9 * 60 * 1000);

// =================================================
// ERROR HANDLING
// =================================================

bot.catch((error, ctx) => {
    logError(error);
    console.error("Telegram update error:", ctx?.update?.update_id);
});

process.on("unhandledRejection", reason => {
    logError(reason);
});

process.on("uncaughtException", error => {
    logError(error);
});

// =================================================
// START SERVER + BOT
// =================================================

app.listen(PORT, "0.0.0.0", () => {
    console.log(`SMW HOSTING web server running on ${PORT}`);
});

(async () => {
    try {
        await bot.launch();
        botReady = true;
        botStartedAt = Date.now();

        console.log("SMW HOSTING Telegram bot is online.");
    } catch (error) {
        botReady = false;
        logError(error);
        process.exit(1);
    }
})();

async function shutdown(signal) {
    console.log(`Received ${signal}. Shutting down...`);

    botReady = false;

    try {
        bot.stop(signal);
    } catch (error) {
        logError(error);
    }

    await saveDatabase();

    process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
