#!/usr/bin/env node
/**
 * paperclip-railway/scripts/start.mjs
 *
 * Railway-aware startup wrapper for paperclipai.
 *
 * Flow:
 *  1. If SETUP_COMPLETE env var is not "true", serve the /setup UI on PORT
 *     so the operator can configure and verify env vars via browser.
 *  2. Once the operator clicks "Launch Paperclip", the setup page sets
 *     SETUP_COMPLETE=true (by instructing them to set the Railway env var)
 *     and triggers a redeploy — OR — they can use the "Start Anyway" button
 *     which writes a local flag file and restarts in-process.
 *  3. On subsequent boots (SETUP_COMPLETE=true), skip straight to paperclipai.
 */

import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3100", 10);
const PAPERCLIP_HOME = process.env.PAPERCLIP_HOME || "/paperclip";
const SETUP_FLAG = join(PAPERCLIP_HOME, ".setup_complete");

// ─── helpers ────────────────────────────────────────────────────────────────

function isSetupComplete() {
  return process.env.SETUP_COMPLETE === "true" || existsSync(SETUP_FLAG);
}

function markSetupComplete() {
  mkdirSync(PAPERCLIP_HOME, { recursive: true });
  writeFileSync(SETUP_FLAG, new Date().toISOString());
}

function requiredVars() {
  return [
    {
      key: "DATABASE_URL",
      label: "Database URL",
      description: "PostgreSQL connection string from Railway Postgres service",
      example: "postgresql://user:pass@host:5432/dbname",
      required: true,
    },
    {
      key: "BETTER_AUTH_SECRET",
      label: "Auth Secret",
      description: "Random 32+ char secret for session signing. Use Railway's secret() generator.",
      example: "use {{secret(32)}} in Railway",
      required: true,
    },
    {
      key: "PAPERCLIP_PUBLIC_URL",
      label: "Public URL",
      description: "Your Railway public domain (https://your-app.up.railway.app)",
      example: "https://your-app.up.railway.app",
      required: true,
    },
    {
      key: "PAPERCLIP_ALLOWED_HOSTNAMES",
      label: "Allowed Hostnames",
      description: "Comma-separated hostnames Railway assigned. Must match your public URL host.",
      example: "your-app.up.railway.app",
      required: true,
    },
    {
      key: "PAPERCLIP_DEPLOYMENT_MODE",
      label: "Deployment Mode",
      description: "Use 'authenticated' for production (requires login). 'local_trusted' is local-only.",
      example: "authenticated",
      required: false,
    },
    {
      key: "PAPERCLIP_HOME",
      label: "Paperclip Home",
      description: "Persistent data directory. Must match your Railway volume mount path.",
      example: "/paperclip",
      required: false,
    },
    {
      key: "ANTHROPIC_API_KEY",
      label: "Anthropic API Key",
      description: "Optional. Enables Claude Code adapter for agents.",
      example: "sk-ant-...",
      required: false,
    },
    {
      key: "OPENAI_API_KEY",
      label: "OpenAI API Key",
      description: "Optional. Enables Codex/GPT adapter for agents.",
      example: "sk-...",
      required: false,
    },
  ];
}

function checkEnvStatus() {
  const vars = requiredVars();
  return vars.map((v) => ({
    ...v,
    value: process.env[v.key] ? "✓ Set" : "",
    missing: v.required && !process.env[v.key],
  }));
}

// ─── setup UI server ─────────────────────────────────────────────────────────

function serveSetupPage() {
  console.log(`\n🔧 Paperclip Railway Setup`);
  console.log(`   Setup page available at: http://localhost:${PORT}/setup`);
  console.log(`   Configure your env vars in Railway, then click "Launch Paperclip"\n`);

  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost`);

    // API: check env var status
    if (url.pathname === "/setup/status" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ vars: checkEnvStatus() }));
      return;
    }

    // API: launch paperclip (marks setup done and restarts)
    if (url.pathname === "/setup/launch" && req.method === "POST") {
      markSetupComplete();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: "Launching Paperclip..." }));
      setTimeout(() => {           // ← wrap in setTimeout
        server.close(() => {
          launchPaperclip();
        });
      }, 500);                     // ← 500ms delay
      return;
    }

    // Serve setup page for / and /setup
    if (url.pathname === "/" || url.pathname === "/setup") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(getSetupHTML());
      return;
    }

    res.writeHead(302, { Location: "/setup" });
    res.end();
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`   Setup server listening on port ${PORT}`);
  });
}

// ─── paperclip launcher ──────────────────────────────────────────────────────

function launchPaperclip() {
  console.log("\n🚀 Starting Paperclip...\n");

  // Ensure PAPERCLIP_HOME exists
  mkdirSync(PAPERCLIP_HOME, { recursive: true });

  // Build a minimal config.json in PAPERCLIP_HOME so the CLI doesn't
  // try to run interactive onboarding (which needs a TTY).
  const configPath = join(PAPERCLIP_HOME, "config.json");
  // Always regenerate config to pick up fixes
  if (existsSync(configPath)) unlinkSync(configPath);
  if (!existsSync(configPath)) {
    const config = {
      $meta: {
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        source: "onboard",
      },
      database: {
        provider: "postgres",
        connectionString: process.env.DATABASE_URL,
      },
      logging: {
        mode: "file",
        logDir: join(PAPERCLIP_HOME, "logs"),
      },
      server: {
        deploymentMode: process.env.PAPERCLIP_DEPLOYMENT_MODE || "authenticated",
        deploymentExposure: process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE || "public",
        allowedHostnames: (process.env.PAPERCLIP_ALLOWED_HOSTNAMES || "")
          .split(",").map(h => h.trim()).filter(Boolean),
      },
      auth: {
        baseUrlMode: "explicit",
        publicBaseUrl: process.env.PAPERCLIP_PUBLIC_URL || "",
        disableSignUp: process.env.PAPERCLIP_AUTH_DISABLE_SIGN_UP === "true",
      },
      storage: {
        provider: "local_disk",
        localDiskPath: join(PAPERCLIP_HOME, "storage"),
      },
      secrets: {
        provider: "local_encrypted",
        localEncrypted: {
          keyFilePath: join(PAPERCLIP_HOME, "secrets.key"),
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log(`   Wrote config to ${configPath}`);
  }

  // Set required env vars the CLI/server expects
  process.env.PAPERCLIP_CONFIG = configPath;
  process.env.PAPERCLIP_HOME = PAPERCLIP_HOME;
  process.env.HOST = process.env.HOST || "0.0.0.0";
  process.env.NODE_ENV = process.env.NODE_ENV || "production";

  // Launch paperclipai run. No extra flags needed — the CLI skips interactive
  // onboarding automatically when PAPERCLIP_CONFIG points to an existing file.
  const cli = spawn(
    "node",
    ["node_modules/.bin/paperclipai", "run"],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        PAPERCLIP_CONFIG: configPath,
        PAPERCLIP_HOME: PAPERCLIP_HOME,
      },
    }
  );

  cli.on("error", (err) => {
    console.error("Failed to start paperclipai:", err);
    process.exit(1);
  });

  cli.on("exit", (code) => {
    console.log(`paperclipai exited with code ${code}`);
    process.exit(code ?? 0);
  });
}

// ─── entrypoint ─────────────────────────────────────────────────────────────

if (isSetupComplete()) {
  launchPaperclip();
} else {
  serveSetupPage();
}

// ─── setup HTML ─────────────────────────────────────────────────────────────

function getSetupHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Paperclip Railway Setup</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0f0f10;
      --surface: #18181b;
      --border: #27272a;
      --accent: #6366f1;
      --accent-light: #818cf8;
      --success: #22c55e;
      --warning: #f59e0b;
      --error: #ef4444;
      --text: #fafafa;
      --muted: #71717a;
      --radius: 10px;
    }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      width: 100%;
      max-width: 760px;
      overflow: hidden;
    }
    .card-header {
      padding: 28px 32px 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .logo {
      width: 40px; height: 40px;
      background: var(--accent);
      border-radius: 10px;
      display: flex; align-items: center; justify-content: center;
      font-size: 20px;
    }
    .card-header h1 { font-size: 20px; font-weight: 600; }
    .card-header p { font-size: 13px; color: var(--muted); margin-top: 2px; }
    .card-body { padding: 24px 32px; }

    .section-title {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 12px;
    }

    .var-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 24px; }
    .var-row {
      display: grid;
      grid-template-columns: 200px 1fr 80px;
      align-items: center;
      gap: 12px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 16px;
      transition: border-color 0.15s;
    }
    .var-row.missing { border-color: var(--error); }
    .var-row.ok { border-color: var(--success); }
    .var-key {
      font-size: 13px;
      font-weight: 600;
      font-family: 'Menlo', 'Monaco', monospace;
      color: var(--text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .var-key small {
      display: block;
      font-family: sans-serif;
      font-weight: 400;
      font-size: 11px;
      color: var(--muted);
      margin-top: 2px;
      white-space: normal;
    }
    .var-example {
      font-size: 12px;
      color: var(--muted);
      font-family: 'Menlo', 'Monaco', monospace;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .var-status {
      text-align: right;
      font-size: 12px;
      font-weight: 600;
    }
    .status-ok { color: var(--success); }
    .status-missing { color: var(--error); }
    .status-optional { color: var(--muted); }

    .banner {
      border-radius: 8px;
      padding: 14px 16px;
      font-size: 13px;
      margin-bottom: 20px;
      display: flex;
      align-items: flex-start;
      gap: 10px;
    }
    .banner.info { background: #1e1b4b; border: 1px solid #3730a3; color: #c7d2fe; }
    .banner.warn { background: #1c1400; border: 1px solid var(--warning); color: #fde68a; }
    .banner.success { background: #052e16; border: 1px solid var(--success); color: #bbf7d0; }
    .banner.error { background: #1f0707; border: 1px solid var(--error); color: #fca5a5; }

    .actions { display: flex; gap: 12px; margin-top: 24px; flex-wrap: wrap; }
    button {
      padding: 10px 20px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: opacity 0.15s, transform 0.1s;
    }
    button:active { transform: scale(0.97); }
    .btn-primary {
      background: var(--accent);
      color: white;
    }
    .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-secondary {
      background: var(--border);
      color: var(--text);
    }
    .btn-ghost {
      background: transparent;
      color: var(--muted);
      border: 1px solid var(--border);
    }

    .progress {
      display: none;
      align-items: center;
      gap: 10px;
      margin-top: 20px;
      font-size: 13px;
      color: var(--muted);
    }
    .spinner {
      width: 16px; height: 16px;
      border: 2px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .step-list {
      counter-reset: steps;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-bottom: 24px;
    }
    .step-list li {
      counter-increment: steps;
      padding: 12px 16px 12px 44px;
      position: relative;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      font-size: 13px;
      color: var(--muted);
      line-height: 1.5;
    }
    .step-list li::before {
      content: counter(steps);
      position: absolute;
      left: 14px;
      top: 12px;
      width: 20px; height: 20px;
      background: var(--border);
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 11px;
      font-weight: 700;
      color: var(--text);
    }
    .step-list li strong { color: var(--text); }
    code {
      background: var(--border);
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 12px;
      font-family: 'Menlo', 'Monaco', monospace;
    }

    #refresh-btn { font-size: 13px; }
  </style>
</head>
<body>
<div class="card">
  <div class="card-header">
    <div class="logo">📎</div>
    <div>
      <h1>Paperclip — Railway Setup</h1>
      <p>Configure your environment variables, then launch the server.</p>
    </div>
  </div>
  <div class="card-body">

    <div class="section-title">How to set up</div>
    <ol class="step-list">
      <li>Go to your <strong>Railway project</strong> → open the Paperclip service → click <strong>Variables</strong>.</li>
      <li>Add each required variable below (those marked <span style="color:var(--error)">Missing</span>).</li>
      <li>For <code>BETTER_AUTH_SECRET</code>, use Railway's built-in generator: set the value to <code>\${{secret(32)}}</code>.</li>
      <li>Click <strong>Refresh Status</strong> here to re-check — all required vars should turn green.</li>
      <li>Click <strong>Launch Paperclip</strong>. On first boot, Paperclip will run DB migrations automatically.</li>
      <li>After launch, go to your Railway URL, <strong>sign up</strong> for an account — the first user becomes the board member.</li>
      <li>Once you've created your account, go back to Railway Variables and set <code>PAPERCLIP_AUTH_DISABLE_SIGN_UP=true</code>, then redeploy.</li>
    </ol>

    <div class="section-title">Environment variable status</div>
    <div id="status-banner" class="banner info">
      <span>⏳</span>
      <span>Checking environment variables...</span>
    </div>
    <div class="var-list" id="var-list">
      <!-- populated by JS -->
    </div>

    <div class="actions">
      <button class="btn-primary" id="launch-btn" disabled onclick="launch()">🚀 Launch Paperclip</button>
      <button class="btn-secondary" id="refresh-btn" onclick="refresh()">🔄 Refresh Status</button>
    </div>
    <div class="progress" id="progress">
      <div class="spinner"></div>
      <span id="progress-msg">Launching Paperclip — this tab will stop responding as the server takes over...</span>
    </div>
  </div>
</div>

<script>
  async function refresh() {
    document.getElementById('refresh-btn').textContent = '⏳ Checking...';
    try {
      const res = await fetch('/setup/status');
      const { vars } = await res.json();
      renderVars(vars);
      updateBanner(vars);
    } catch(e) {
      setBanner('error', '❌ Could not reach setup server. Please refresh the page.');
    } finally {
      document.getElementById('refresh-btn').textContent = '🔄 Refresh Status';
    }
  }

  function renderVars(vars) {
    const list = document.getElementById('var-list');
    list.innerHTML = vars.map(v => {
      const cls = v.missing ? 'missing' : v.value ? 'ok' : '';
      const statusCls = v.missing ? 'status-missing' : v.value ? 'status-ok' : 'status-optional';
      const statusText = v.missing ? '✗ Missing' : v.value ? '✓ Set' : '— Optional';
      return \`<div class="var-row \${cls}">
        <div class="var-key">\${v.key}<small>\${v.label}</small></div>
        <div class="var-example">\${v.value || v.example}</div>
        <div class="var-status \${statusCls}">\${statusText}</div>
      </div>\`;
    }).join('');
  }

  function updateBanner(vars) {
    const missing = vars.filter(v => v.missing);
    if (missing.length === 0) {
      setBanner('success', '✅ All required variables are set. You can launch Paperclip.');
      document.getElementById('launch-btn').disabled = false;
    } else {
      setBanner('warn', \`⚠️ \${missing.length} required variable\${missing.length>1?'s are':' is'} missing: \${missing.map(v=>v.key).join(', ')}\`);
      document.getElementById('launch-btn').disabled = true;
    }
  }

  function setBanner(type, msg) {
    const b = document.getElementById('status-banner');
    b.className = 'banner ' + type;
    b.innerHTML = '<span>' + msg + '</span>';
  }

  async function launch() {
    document.getElementById('launch-btn').disabled = true;
    document.getElementById('progress').style.display = 'flex';
    setBanner('info', '🚀 Launching Paperclip server...');
    try {
      await fetch('/setup/launch', { method: 'POST' });
    } catch(_) {
      // Expected — server shuts down setup and starts paperclip
    }
    document.getElementById('progress-msg').textContent =
      'Paperclip is starting up. This page will redirect in a moment...';
    // Poll until paperclip is up
    let attempts = 0;
    const interval = setInterval(async () => {
      attempts++;
      try {
        const r = await fetch('/');
        if (r.ok && r.url && !r.url.includes('/setup')) {
          clearInterval(interval);
          window.location.href = '/';
        }
      } catch(_) {}
      if (attempts > 60) {
        clearInterval(interval);
        document.getElementById('progress-msg').textContent =
          'Paperclip should be starting. Try visiting your Railway URL in a few seconds.';
      }
    }, 2000);
  }

  refresh();
</script>
</body>
</html>`;
}
