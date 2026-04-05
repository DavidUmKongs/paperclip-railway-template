#!/usr/bin/env node
/**
 * paperclip-railway/scripts/start.mjs
 *
 * Startup wrapper for paperclipai on Railway.
 *
 * Port layout:
 *   PUBLIC_PORT (3100) — owned by this wrapper, always
 *   PAPERCLIP_PORT (3099) — internal, Paperclip only
 *
 * Routing:
 *   /setup/*  → always handled here (env check, setup auth, launch, invite, Codex login, reset)
 *   /         → proxy if ready, else redirect to /setup
 *   everything else → proxy if ready, else redirect to /setup
 *
 * "Ready" is derived — no flag files, no SETUP_COMPLETE env var.
 *   isReady() = config.json exists AND all 4 required env vars are set
 */

import { createServer, request as httpRequest } from "http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, rmSync } from "fs";
import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { randomBytes, timingSafeEqual } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const NODE_BIN = process.execPath;

const PUBLIC_PORT = parseInt(process.env.PORT || "3100", 10);
const PAPERCLIP_PORT = 3099;
const HOME = process.env.PAPERCLIP_HOME || "/paperclip";
const CONFIG_PATH = join(HOME, "config.json");
const INVITE_FILE = join(HOME, "bootstrap-invite.txt");
const SKIP_REASON_FILE = join(HOME, "bootstrap-skip-reason.txt");
const CODEX_HOME = process.env.CODEX_HOME || join(HOME, ".codex");
const CODEX_CONFIG_PATH = join(CODEX_HOME, "config.toml");
const CODEX_AUTH_PATH = join(CODEX_HOME, "auth.json");
const CODEX_STATE_PATH = join(HOME, "codex-device-auth-state.json");
const SETUP_PASSWORD = process.env.PAPERCLIP_SETUP_PASSWORD || "";
const SETUP_SESSION_COOKIE = "paperclip_setup_session";
const SETUP_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const CODEX_LOGIN_TIMEOUT_MS = 15 * 60 * 1000 + 30 * 1000;

function resolvePackageBin(packageName, preferredBinName = null) {
  const packageJsonPath = require.resolve(`${packageName}/package.json`);
  const packageJsonDir = dirname(packageJsonPath);
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const binField = pkg.bin;
  if (typeof binField === "string") {
    return join(packageJsonDir, binField);
  }
  if (preferredBinName && binField?.[preferredBinName]) {
    return join(packageJsonDir, binField[preferredBinName]);
  }
  const firstBinPath = Object.values(binField || {})[0];
  if (!firstBinPath) {
    throw new Error(`Could not resolve CLI binary for ${packageName}`);
  }
  return join(packageJsonDir, firstBinPath);
}

const PAPERCLIP_BIN = resolvePackageBin("paperclipai");
const CODEX_BIN = resolvePackageBin("@openai/codex", "codex");

// Strip ANSI escape sequences (colors, cursor, etc.) from strings
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function nowIso() {
  return new Date().toISOString();
}

function writeJson(res, statusCode, body, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > 16 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return header.split(";").reduce((acc, entry) => {
    const [rawKey, ...rawValue] = entry.trim().split("=");
    if (!rawKey) return acc;
    acc[rawKey] = decodeURIComponent(rawValue.join("=") || "");
    return acc;
  }, {});
}

function createSessionCookie(value, maxAgeSeconds) {
  return `${SETUP_SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function clearSessionCookie() {
  return `${SETUP_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function safeSecretCompare(left, right) {
  const leftBuf = Buffer.from(left, "utf8");
  const rightBuf = Buffer.from(right, "utf8");
  const len = Math.max(leftBuf.length, rightBuf.length);
  const paddedLeft = Buffer.alloc(len);
  const paddedRight = Buffer.alloc(len);
  leftBuf.copy(paddedLeft);
  rightBuf.copy(paddedRight);
  return timingSafeEqual(paddedLeft, paddedRight) && leftBuf.length === rightBuf.length;
}

function defaultCodexState(overrides = {}) {
  return {
    phase: "idle",
    verificationUrl: null,
    userCode: null,
    message: "Codex is not connected.",
    error: null,
    startedAt: null,
    updatedAt: nowIso(),
    lastCompletedAt: null,
    lastExitCode: null,
    outputTail: "",
    ...overrides,
  };
}

// ── Global state ─────────────────────────────────────────────────────────────

let paperclipProc = null;
let paperclipReady = false;
let paperclipStopRequested = false;
let inviteUrl = null;
let bootstrapSkippedReason = null;
let codexLoginProc = null;
let codexLoginStopReason = null;
let codexState = defaultCodexState();

const setupSessions = new Map();

function persistCodexState() {
  writeFileSync(CODEX_STATE_PATH, JSON.stringify(codexState, null, 2));
}

function replaceCodexState(nextState) {
  codexState = {
    ...defaultCodexState(),
    ...nextState,
    updatedAt: nowIso(),
  };
  persistCodexState();
}

function mergeCodexState(patch) {
  replaceCodexState({
    ...codexState,
    ...patch,
  });
}

function loadPersistedCodexState() {
  if (!existsSync(CODEX_STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CODEX_STATE_PATH, "utf8"));
  } catch (_) {
    return null;
  }
}

function ensureCodexHome() {
  mkdirSync(CODEX_HOME, { recursive: true });
  const desiredConfig = "cli_auth_credentials_store = \"file\"\n";
  let currentConfig = null;
  if (existsSync(CODEX_CONFIG_PATH)) {
    try {
      currentConfig = readFileSync(CODEX_CONFIG_PATH, "utf8");
    } catch (_) {
      currentConfig = null;
    }
  }
  if (currentConfig !== desiredConfig) {
    writeFileSync(CODEX_CONFIG_PATH, desiredConfig);
  }
}

function clearCodexArtifacts() {
  if (existsSync(CODEX_HOME)) {
    rmSync(CODEX_HOME, { recursive: true, force: true });
  }
  if (existsSync(CODEX_STATE_PATH)) {
    unlinkSync(CODEX_STATE_PATH);
  }
  ensureCodexHome();
  replaceCodexState(defaultCodexState());
}

function codexEnv(extraEnv = {}) {
  ensureCodexHome();
  return {
    ...process.env,
    CODEX_HOME,
    ...extraEnv,
  };
}

function truncateTail(existing, incoming) {
  return `${existing}${incoming}`.slice(-4000);
}

function parseCodexDeviceAuthOutput(text) {
  const clean = stripAnsi(text);
  const verificationUrlMatch = clean.match(/https?:\/\/\S+/);
  const userCodeMatch = clean.match(/\b[A-Z0-9]{4,}(?:-[A-Z0-9]{3,})+\b/);
  return {
    verificationUrl: verificationUrlMatch ? verificationUrlMatch[0].trim() : null,
    userCode: userCodeMatch ? userCodeMatch[0].trim() : null,
    waiting: /Waiting for authorization|Follow these steps to sign in|Open this link in your browser|Enter this one-time code|Enter code:/i.test(clean),
    browserFallback: /Starting local login server|If your browser did not open|localhost:\d+\/auth\/callback|Press Esc to cancel/i.test(clean),
    success: /Successfully logged in/i.test(clean),
  };
}

function loadInviteArtifactsFromDisk() {
  if (!inviteUrl && existsSync(INVITE_FILE)) {
    try {
      inviteUrl = stripAnsi(readFileSync(INVITE_FILE, "utf8")).trim();
    } catch (_) { }
  }
  if (!bootstrapSkippedReason && existsSync(SKIP_REASON_FILE)) {
    try {
      bootstrapSkippedReason = readFileSync(SKIP_REASON_FILE, "utf8").trim();
    } catch (_) { }
  }
}

// ── Setup auth ───────────────────────────────────────────────────────────────

function cleanupExpiredSetupSessions() {
  const now = Date.now();
  for (const [sessionId, session] of setupSessions.entries()) {
    if (session.expiresAt <= now) {
      setupSessions.delete(sessionId);
    }
  }
}

function getSetupSessionId(req) {
  const cookies = parseCookies(req);
  return cookies[SETUP_SESSION_COOKIE] || null;
}

function isSetupAuthenticated(req) {
  if (!SETUP_PASSWORD) return false;
  cleanupExpiredSetupSessions();
  const sessionId = getSetupSessionId(req);
  if (!sessionId) return false;
  const session = setupSessions.get(sessionId);
  if (!session) return false;
  if (session.expiresAt <= Date.now()) {
    setupSessions.delete(sessionId);
    return false;
  }
  return true;
}

function createSetupSession() {
  const sessionId = randomBytes(32).toString("hex");
  setupSessions.set(sessionId, {
    expiresAt: Date.now() + SETUP_SESSION_TTL_MS,
  });
  return sessionId;
}

function revokeSetupSession(req) {
  const sessionId = getSetupSessionId(req);
  if (sessionId) {
    setupSessions.delete(sessionId);
  }
}

function setupAuthState(req) {
  const passwordConfigured = !!SETUP_PASSWORD;
  const authenticated = passwordConfigured ? isSetupAuthenticated(req) : false;
  return {
    passwordConfigured,
    required: passwordConfigured,
    authenticated,
    codexPasswordRequired: true,
    codexAvailable: passwordConfigured,
  };
}

function requireSetupAuth(req, res, options = {}) {
  const {
    requirePasswordConfigured = false,
    purpose = "continue with setup",
  } = options;

  if (!SETUP_PASSWORD) {
    if (requirePasswordConfigured) {
      writeJson(res, 428, {
        ok: false,
        code: "setup_password_required",
        error: "Set PAPERCLIP_SETUP_PASSWORD before using Codex Plan login.",
      });
      return false;
    }
    return true;
  }

  if (!isSetupAuthenticated(req)) {
    writeJson(res, 401, {
      ok: false,
      code: "setup_auth_required",
      error: `Unlock setup with PAPERCLIP_SETUP_PASSWORD to ${purpose}.`,
    });
    return false;
  }

  return true;
}

// ── Ready check (derived from reality, no flags) ─────────────────────────────

const REQUIRED_VARS = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "PAPERCLIP_PUBLIC_URL",
  "PAPERCLIP_ALLOWED_HOSTNAMES",
];

function isReady() {
  return REQUIRED_VARS.every(k => !!process.env[k]) && existsSync(CONFIG_PATH);
}

// ── Config builder ────────────────────────────────────────────────────────────

function writeConfig() {
  mkdirSync(HOME, { recursive: true });
  mkdirSync(join(HOME, "logs"), { recursive: true });
  mkdirSync(join(HOME, "storage"), { recursive: true });
  ensureCodexHome();

  const config = {
    $meta: {
      version: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      source: "onboard",
    },
    database: {
      provider: "postgres",
      connectionString: process.env.DATABASE_URL,
    },
    logging: {
      mode: "file",
      logDir: join(HOME, "logs"),
    },
    server: {
      deploymentMode: process.env.PAPERCLIP_DEPLOYMENT_MODE || "authenticated",
      deploymentExposure: process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE || "public",
      allowedHostnames: (process.env.PAPERCLIP_ALLOWED_HOSTNAMES || "")
        .split(",").map(h => h.trim()).filter(Boolean),
      port: PAPERCLIP_PORT,
      host: "127.0.0.1",
    },
    auth: {
      baseUrlMode: "explicit",
      publicBaseUrl: process.env.PAPERCLIP_PUBLIC_URL || "",
      disableSignUp: process.env.PAPERCLIP_AUTH_DISABLE_SIGN_UP === "true",
    },
    storage: {
      provider: "local_disk",
      localDiskPath: join(HOME, "storage"),
    },
    secrets: {
      provider: "local_encrypted",
      localEncrypted: {
        keyFilePath: join(HOME, "secrets.key"),
      },
    },
  };

  // Always overwrite — keeps config in sync with env vars on every boot
  if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log(`   Config written to ${CONFIG_PATH}`);
}

// ── CLI helpers ───────────────────────────────────────────────────────────────

function runNodeBin(scriptPath, args, options = {}) {
  return spawn(NODE_BIN, [scriptPath, ...args], options);
}

function runNodeBinAndCapture(scriptPath, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const proc = runNodeBin(scriptPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...extraEnv,
      },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", chunk => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });
    proc.on("error", error => {
      resolve({ code: null, stdout, stderr, error });
    });
    proc.on("exit", code => {
      resolve({ code, stdout, stderr, error: null });
    });
  });
}

async function detectCodexAuthStatus() {
  ensureCodexHome();
  const result = await runNodeBinAndCapture(CODEX_BIN, ["login", "status"], codexEnv());
  const combined = stripAnsi(`${result.stdout}\n${result.stderr}`.trim());
  const authenticated =
    (/Logged in using ChatGPT|Authenticated:\s*Yes|Method:\s*ChatGPT|Method:\s*ChatGPT OAuth/i.test(combined)) &&
    !/Not logged in|Authenticated:\s*No/i.test(combined);

  return {
    authenticated,
    code: result.code,
    output: combined,
    error: result.error ? String(result.error) : null,
  };
}

function codexClientState(req) {
  const auth = setupAuthState(req);
  if (!auth.passwordConfigured) {
    return {
      available: false,
      locked: false,
      phase: "unavailable",
      message: "Set PAPERCLIP_SETUP_PASSWORD to unlock Codex Plan login and protect setup actions.",
      error: null,
    };
  }
  if (!auth.authenticated) {
    return {
      available: true,
      locked: true,
      phase: "locked",
      message: "Unlock setup with PAPERCLIP_SETUP_PASSWORD to view or manage Codex Plan login.",
      error: null,
    };
  }
  return {
    available: true,
    locked: false,
    ...codexState,
  };
}

async function initializeCodexState() {
  ensureCodexHome();

  const persisted = loadPersistedCodexState();
  if (persisted) {
    codexState = {
      ...defaultCodexState(),
      ...persisted,
    };
  } else {
    persistCodexState();
  }

  const status = await detectCodexAuthStatus();
  if (status.authenticated) {
    replaceCodexState({
      phase: "authenticated",
      verificationUrl: null,
      userCode: null,
      message: "Codex is connected using ChatGPT OAuth.",
      error: null,
      outputTail: status.output,
      lastCompletedAt: nowIso(),
      lastExitCode: status.code,
    });
    return;
  }

  if (codexState.phase === "starting" || codexState.phase === "pending") {
    replaceCodexState({
      phase: "error",
      verificationUrl: null,
      userCode: null,
      message: "A previous Codex login was interrupted. Start the device login again.",
      error: null,
      startedAt: null,
      lastExitCode: status.code,
    });
    return;
  }

  if (codexState.phase === "authenticated") {
    replaceCodexState(defaultCodexState());
    return;
  }

  persistCodexState();
}

function stopCodexLogin(message = "Codex login cancelled.") {
  if (!codexLoginProc) {
    replaceCodexState(defaultCodexState({ message }));
    return;
  }
  codexLoginStopReason = message;
  codexLoginProc.kill("SIGTERM");
}

function handleCodexLoginChunk(text, stream = "stdout") {
  if (stream === "stdout") {
    process.stdout.write(text);
  } else {
    process.stderr.write(text);
  }

  const clean = stripAnsi(text);
  const outputTail = truncateTail(codexState.outputTail || "", clean);
  const parsed = parseCodexDeviceAuthOutput(outputTail);

  const patch = {
    outputTail,
  };

  if (parsed.verificationUrl) {
    patch.verificationUrl = parsed.verificationUrl;
  }
  if (parsed.userCode) {
    patch.userCode = parsed.userCode;
  }

  if (parsed.verificationUrl || parsed.userCode || parsed.waiting) {
    patch.phase = parsed.verificationUrl && parsed.userCode ? "pending" : "starting";
    patch.message = parsed.verificationUrl && parsed.userCode
      ? "Open the verification URL and enter the code. Waiting for authorization..."
      : "Requesting a Codex device verification code...";
    patch.error = null;
  }

  if (parsed.success) {
    patch.message = "Authorization completed. Finalizing Codex login...";
  }

  mergeCodexState(patch);

  if (parsed.browserFallback && !parsed.userCode && codexLoginProc) {
    mergeCodexState({
      phase: "error",
      message: "Codex fell back to browser login instead of device code.",
      error: "Device code auth may not be enabled for this ChatGPT account or workspace.",
      startedAt: null,
    });
    codexLoginStopReason = "Codex device-code login is unavailable in this environment.";
    codexLoginProc.kill("SIGTERM");
  }
}

async function startCodexDeviceLogin() {
  if (codexLoginProc) return;

  ensureCodexHome();

  const existingStatus = await detectCodexAuthStatus();
  if (existingStatus.authenticated) {
    replaceCodexState({
      phase: "authenticated",
      verificationUrl: null,
      userCode: null,
      message: "Codex is connected using ChatGPT OAuth.",
      error: null,
      outputTail: existingStatus.output,
      lastCompletedAt: nowIso(),
      lastExitCode: existingStatus.code,
    });
    return;
  }

  replaceCodexState({
    phase: "starting",
    verificationUrl: null,
    userCode: null,
    message: "Starting `codex login --device-auth`...",
    error: null,
    startedAt: nowIso(),
    outputTail: "",
    lastExitCode: null,
  });

  codexLoginStopReason = null;

  const proc = runNodeBin(CODEX_BIN, ["login", "--device-auth"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: codexEnv(),
  });

  codexLoginProc = proc;

  proc.stdout.on("data", chunk => handleCodexLoginChunk(chunk.toString(), "stdout"));
  proc.stderr.on("data", chunk => handleCodexLoginChunk(chunk.toString(), "stderr"));

  proc.on("error", (err) => {
    codexLoginProc = null;
    replaceCodexState({
      phase: "error",
      verificationUrl: null,
      userCode: null,
      message: "Failed to start Codex login.",
      error: String(err),
      startedAt: null,
    });
  });

  proc.on("exit", async (code) => {
    const stopReason = codexLoginStopReason;
    const stoppedByRequest = !!stopReason;
    codexLoginProc = null;
    codexLoginStopReason = null;

    if (stoppedByRequest) {
      replaceCodexState(defaultCodexState({ message: stopReason, lastExitCode: code }));
      return;
    }

    const status = await detectCodexAuthStatus();
    if (status.authenticated) {
      replaceCodexState({
        phase: "authenticated",
        verificationUrl: null,
        userCode: null,
        message: "Codex is connected using ChatGPT OAuth.",
        error: null,
        outputTail: status.output || codexState.outputTail,
        startedAt: null,
        lastCompletedAt: nowIso(),
        lastExitCode: code,
      });
      return;
    }

    replaceCodexState({
      phase: "error",
      message: codexState.message === "Authorization completed. Finalizing Codex login..."
        ? "Codex login exited before a reusable session was detected."
        : codexState.message || "Codex login did not complete.",
      error: codexState.error || status.error || status.output || "Codex login did not complete.",
      startedAt: null,
      lastExitCode: code,
    });
  });

  const loginTimeout = setTimeout(() => {
    if (codexLoginProc === proc) {
      codexLoginStopReason = "Codex login timed out. Start the device login again.";
      proc.kill("SIGTERM");
    }
  }, CODEX_LOGIN_TIMEOUT_MS);

  proc.on("exit", () => clearTimeout(loginTimeout));
}

// ── Paperclip process ─────────────────────────────────────────────────────────

function startPaperclip() {
  if (paperclipProc) return; // already running

  console.log(`\n🚀 Starting Paperclip on internal port ${PAPERCLIP_PORT}...\n`);

  writeConfig();
  paperclipStopRequested = false;

  const proc = runNodeBin(PAPERCLIP_BIN, ["run"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PAPERCLIP_CONFIG: CONFIG_PATH,
      PAPERCLIP_HOME: HOME,
      CODEX_HOME,
      PORT: String(PAPERCLIP_PORT),
      HOST: "127.0.0.1",
      NODE_ENV: process.env.NODE_ENV || "production",
    },
  });

  paperclipProc = proc;

  proc.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);

    const clean = stripAnsi(text);

    // Capture bootstrap invite URL
    const match = clean.match(/https?:\/\/\S+\/invite\/pcp_bootstrap_\S+/);
    if (match) {
      inviteUrl = match[0].trim();
      bootstrapSkippedReason = null;
      writeFileSync(INVITE_FILE, inviteUrl);
      if (existsSync(SKIP_REASON_FILE)) unlinkSync(SKIP_REASON_FILE);
      console.log(`\n✅ Bootstrap invite URL saved to ${INVITE_FILE}\n`);
    }

    // Detect "admin already exists" — Paperclip skips invite generation
    if (clean.includes("Instance already has an admin user")) {
      bootstrapSkippedReason = "An admin account already exists. You can log in directly from the dashboard.";
      writeFileSync(SKIP_REASON_FILE, bootstrapSkippedReason);
      console.log(`\n⚠️ Bootstrap invite skipped: admin already exists.\n`);
    }

    // Detect ready
    if (!paperclipReady && (text.includes("Server listening on") || text.includes("server listening"))) {
      paperclipReady = true;
      console.log(`\n✅ Paperclip ready — proxying :${PUBLIC_PORT} → :${PAPERCLIP_PORT}\n`);
    }
  });

  proc.stderr.on("data", chunk => process.stderr.write(chunk));

  proc.on("error", err => {
    console.error("Paperclip process error:", err);
    paperclipProc = null;
    paperclipReady = false;
    paperclipStopRequested = false;
  });

  proc.on("exit", (code) => {
    const wasRequested = paperclipStopRequested;
    paperclipProc = null;
    paperclipReady = false;
    paperclipStopRequested = false;

    if (wasRequested) {
      console.log("Paperclip stopped by setup action.");
      return;
    }

    console.log(`Paperclip exited with code ${code}`);
    // Railway will restart the whole container on exit — don't try to restart here
    process.exit(code ?? 1);
  });
}

function stopPaperclip() {
  if (!paperclipProc) return;
  paperclipReady = false;
  paperclipStopRequested = true;
  paperclipProc.kill("SIGTERM");
}

// ── Reset ─────────────────────────────────────────────────────────────────────

function resetSetup() {
  stopPaperclip();
  stopCodexLogin("Codex login cancelled during reset.");
  if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  if (existsSync(INVITE_FILE)) unlinkSync(INVITE_FILE);
  if (existsSync(SKIP_REASON_FILE)) unlinkSync(SKIP_REASON_FILE);
  inviteUrl = null;
  bootstrapSkippedReason = null;
  clearCodexArtifacts();
  console.log("\n🔄 Setup reset. Config, invite data, and Codex auth cache deleted.\n");
}

// ── Proxy ─────────────────────────────────────────────────────────────────────

function proxy(req, res) {
  if (!paperclipReady) {
    res.writeHead(503, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f0f10;color:#fff">
      <div style="text-align:center">
        <div style="font-size:32px;margin-bottom:16px">⏳</div>
        <h2>Paperclip is starting up...</h2>
        <p style="color:#71717a;margin-top:8px">This page will refresh automatically.</p>
        <script>setTimeout(()=>location.reload(),3000)<\/script>
      </div></body></html>`);
    return;
  }

  const opts = {
    hostname: "127.0.0.1",
    port: PAPERCLIP_PORT,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      "x-forwarded-host": req.headers.host,
      "x-forwarded-proto": "https",
      "x-forwarded-for": req.socket.remoteAddress,
    },
  };

  const upstream = httpRequest(opts, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res, { end: true });
  });

  upstream.on("error", () => {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Paperclip is restarting — please refresh in a moment.");
  });

  req.pipe(upstream, { end: true });
}

// ── Env var status (for setup page) ──────────────────────────────────────────

function envVarStatus() {
  const all = [
    { key: "DATABASE_URL", required: true, label: "Database URL", example: "postgresql://user:pass@host:5432/db" },
    { key: "BETTER_AUTH_SECRET", required: true, label: "Auth Secret", example: "${{secret(32)}} — use Railway generator" },
    { key: "PAPERCLIP_PUBLIC_URL", required: true, label: "Public URL", example: "https://your-app.up.railway.app" },
    { key: "PAPERCLIP_ALLOWED_HOSTNAMES", required: true, label: "Allowed Hostnames", example: "your-app.up.railway.app" },
    { key: "PAPERCLIP_DEPLOYMENT_MODE", required: false, label: "Deployment Mode", example: "authenticated" },
    { key: "PAPERCLIP_HOME", required: false, label: "Paperclip Home", example: "/paperclip" },
    { key: "PAPERCLIP_SETUP_PASSWORD", required: false, label: "Setup Password", example: "Required to unlock setup actions and Codex Plan login" },
    { key: "ANTHROPIC_API_KEY", required: false, label: "Anthropic API Key", example: "sk-ant-..." },
    { key: "OPENAI_API_KEY", required: false, label: "OpenAI API Key (usage-billed fallback)", example: "Only set this if you want API-billed fallback instead of Codex Plan OAuth" },
  ];
  return all.map(v => ({
    ...v,
    set: !!process.env[v.key],
    missing: v.required && !process.env[v.key],
  }));
}

// ── HTTP server ───────────────────────────────────────────────────────────────

function startServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const method = req.method;
    const ready = isReady();

    // ── Setup API routes (always available) ──────────────────────────────────

    if (path === "/setup/status" && method === "GET") {
      writeJson(res, 200, {
        vars: envVarStatus(),
        configExists: existsSync(CONFIG_PATH),
        paperclipReady,
        ready,
        setupAuth: setupAuthState(req),
      });
      return;
    }

    if (path === "/setup/auth/login" && method === "POST") {
      if (!SETUP_PASSWORD) {
        writeJson(res, 428, {
          ok: false,
          code: "setup_password_required",
          error: "Set PAPERCLIP_SETUP_PASSWORD before using setup auth.",
        });
        return;
      }

      (async () => {
        try {
          let parsed = {};
          try {
            const bodyText = await readRequestBody(req);
            parsed = bodyText ? JSON.parse(bodyText) : {};
          } catch (_) {
            writeJson(res, 400, {
              ok: false,
              code: "invalid_request",
              error: "Could not read the setup password payload.",
            });
            return;
          }

          const password = String(parsed.password || "");
          if (!safeSecretCompare(password, SETUP_PASSWORD)) {
            writeJson(res, 401, {
              ok: false,
              code: "invalid_password",
              error: "Incorrect setup password.",
            });
            return;
          }

          const sessionId = createSetupSession();
          writeJson(
            res,
            200,
            { ok: true, setupAuth: { ...setupAuthState(req), authenticated: true } },
            { "Set-Cookie": createSessionCookie(sessionId, Math.floor(SETUP_SESSION_TTL_MS / 1000)) }
          );
        } catch (err) {
          console.error("Login error:", err);
          writeJson(res, 500, { ok: false, error: "Internal server error during login." });
        }
      })();
      return;
    }

    if (path === "/setup/auth/logout" && method === "POST") {
      revokeSetupSession(req);
      writeJson(
        res,
        200,
        { ok: true },
        { "Set-Cookie": clearSessionCookie() }
      );
      return;
    }

    if (path === "/setup/codex/status" && method === "GET") {
      writeJson(res, 200, codexClientState(req));
      return;
    }

    if (path === "/setup/codex/start" && method === "POST") {
      if (!requireSetupAuth(req, res, { requirePasswordConfigured: true, purpose: "start Codex Plan login" })) {
        return;
      }

      (async () => {
        try {
          await startCodexDeviceLogin();
          writeJson(res, 200, {
            ok: true,
            state: codexClientState(req),
          });
        } catch (err) {
          console.error("Codex start error:", err);
          writeJson(res, 500, { ok: false, error: "Internal server error starting Codex login." });
        }
      })();
      return;
    }

    if (path === "/setup/codex/cancel" && method === "POST") {
      if (!requireSetupAuth(req, res, { requirePasswordConfigured: true, purpose: "cancel Codex Plan login" })) {
        return;
      }
      stopCodexLogin("Codex login cancelled.");
      writeJson(res, 200, {
        ok: true,
        state: codexClientState(req),
      });
      return;
    }

    if (path === "/setup/codex/logout" && method === "POST") {
      if (!requireSetupAuth(req, res, { requirePasswordConfigured: true, purpose: "remove Codex credentials" })) {
        return;
      }
      stopCodexLogin("Codex login cancelled.");
      clearCodexArtifacts();
      writeJson(res, 200, {
        ok: true,
        state: codexClientState(req),
      });
      return;
    }

    if (path === "/setup/invite" && method === "GET") {
      if (!requireSetupAuth(req, res, { purpose: "view the bootstrap invite" })) {
        return;
      }
      loadInviteArtifactsFromDisk();
      writeJson(res, 200, {
        url: inviteUrl,
        paperclipReady,
        skippedReason: bootstrapSkippedReason || null,
      });
      return;
    }

    if (path === "/setup/launch" && method === "POST") {
      if (!requireSetupAuth(req, res, { purpose: "launch Paperclip" })) {
        return;
      }
      if (paperclipProc) {
        writeJson(res, 200, { ok: true, already: true });
        return;
      }
      writeJson(res, 200, { ok: true });
      setTimeout(() => startPaperclip(), 300);
      return;
    }

    if (path === "/setup/rotate-invite" && method === "POST") {
      if (!requireSetupAuth(req, res, { purpose: "rotate the bootstrap invite" })) {
        return;
      }

      const proc = runNodeBin(PAPERCLIP_BIN, ["auth", "bootstrap-ceo", "--force"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PAPERCLIP_CONFIG: CONFIG_PATH,
          PAPERCLIP_HOME: HOME,
          CODEX_HOME,
        },
      });

      let responded = false;
      const ROTATE_TIMEOUT_MS = 60_000;

      const watchdog = setTimeout(() => {
        if (!responded) {
          responded = true;
          proc.kill("SIGTERM");
          writeJson(res, 504, { ok: false, error: "Rotate invite timed out." });
        }
      }, ROTATE_TIMEOUT_MS);

      let out = "";
      proc.stdout.on("data", d => {
        out += d.toString();
        const clean = stripAnsi(out);
        const match = clean.match(/https?:\/\/\S+\/invite\/pcp_bootstrap_\S+/);
        if (match) {
          inviteUrl = match[0].trim();
          writeFileSync(INVITE_FILE, inviteUrl);
          bootstrapSkippedReason = null;
          if (existsSync(SKIP_REASON_FILE)) unlinkSync(SKIP_REASON_FILE);
        }
      });
      proc.stderr.on("data", d => process.stderr.write(d));
      proc.on("exit", () => {
        clearTimeout(watchdog);
        if (!responded) {
          responded = true;
          writeJson(res, 200, { url: inviteUrl });
        }
      });
      return;
    }

    if (path === "/setup/reset" && method === "POST") {
      if (!requireSetupAuth(req, res, { purpose: "reset setup" })) {
        return;
      }
      resetSetup();
      writeJson(res, 200, { ok: true });
      return;
    }

    // ── Setup page ────────────────────────────────────────────────────────────

    if (path === "/setup") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(readFileSync(join(__dirname, "setup.html"), "utf8"));
      return;
    }

    // ── Root + everything else ────────────────────────────────────────────────

    if (!ready) {
      res.writeHead(302, { Location: "/setup" });
      res.end();
      return;
    }

    proxy(req, res);
  });

  server.listen(PUBLIC_PORT, "0.0.0.0", () => {
    console.log(`\n🔧 Wrapper listening on port ${PUBLIC_PORT}`);
    console.log(`   Visit /setup to configure or manage your instance.\n`);
  });
}

// ── Entrypoint ────────────────────────────────────────────────────────────────

async function main() {
  await initializeCodexState();
  loadInviteArtifactsFromDisk();
  startServer();

  if (isReady()) {
    startPaperclip();
  }
}

main().catch((err) => {
  console.error("Failed to initialize wrapper:", err);
  process.exit(1);
});
