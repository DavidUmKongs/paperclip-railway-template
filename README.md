# paperclip-railway

> A Railway-ready wrapper for [paperclipai/paperclip](https://github.com/paperclipai/paperclip) with a web-based `/setup` page — no shell access required.

Railway doesn't provide shell access during deployment, so the normal `pnpm paperclipai onboard` flow can't run. This repo solves that by:

1. Serving a **web-based setup page** at your Railway URL that checks required env vars and can lock sensitive setup actions behind a setup password.
2. Letting you run **`codex login --device-auth` from the setup page** so you can use your ChatGPT/Codex Plan via OAuth instead of an OpenAI API key.
3. Launching the real Paperclip server once you're ready, then proxying normal traffic to it.

---

## Deploy to Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/paperclip-ai-company)

### Manual steps

1. **Fork or clone this repo** into your own GitHub account.
2. **Create a new Railway project** and add:
   - A **PostgreSQL** database service
   - A **new service** pointing at your fork of this repo
3. **Add a volume** to the Paperclip service, mounted at `/paperclip`.
4. **Set these environment variables** on the Paperclip service:

```env
DATABASE_URL="${{Postgres.DATABASE_URL}}"
BETTER_AUTH_SECRET="${{secret(32)}}"
PAPERCLIP_PUBLIC_URL="https://your-app.up.railway.app"
PAPERCLIP_ALLOWED_HOSTNAMES="your-app.up.railway.app"
PAPERCLIP_DEPLOYMENT_MODE="authenticated"
PAPERCLIP_HOME="/paperclip"
PAPERCLIP_SETUP_PASSWORD="${{secret(32)}}"
HOST="0.0.0.0"
PORT="3100"
NODE_ENV="production"
```

Optional:

```env
# Only set this if you want usage-billed OpenAI API fallback.
OPENAI_API_KEY="sk-..."
```

5. **Deploy** — Railway runs `npm start`, which serves the wrapper and setup page.
6. **Open your Railway URL**.
   - If you set `PAPERCLIP_SETUP_PASSWORD`, unlock setup first.
   - Verify all required vars are green.
   - If you want to use Codex through your ChatGPT/Codex Plan, use the **Codex Plan (ChatGPT OAuth)** section to start device login and complete the verification URL + one-time code flow in your browser.
   - Click **Go to Manage** to launch Paperclip.
7. **Sign up** for an account on the Paperclip UI. The first user automatically gets board-level access.
8. **Lock sign-ups**: go back to Railway Variables, add `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true`, and redeploy.

---

## How it works

```text
npm start
  └── scripts/start.mjs
        ├── always serves the wrapper on PUBLIC_PORT
        ├── /setup/status          → env var + setup-auth state
        ├── /setup/codex/*         → runs codex device auth and stores auth under /paperclip/.codex
        ├── /setup/launch          → writes config.json and starts paperclipai on an internal port
        ├── /setup/invite          → exposes the bootstrap invite after launch
        └── everything else        → redirects to /setup until ready, then proxies to Paperclip
```

The setup page checks Railway env vars through `/setup/status`. Sensitive actions such as launch, invite access, reset, and Codex device login can be locked behind `PAPERCLIP_SETUP_PASSWORD`.

Codex login state is persisted under `/paperclip/.codex`, so the OAuth session survives restarts and redeploys as long as the Railway volume stays attached.

---

## Files

```text
paperclip-railway/
├── package.json          # installs paperclipai and Codex, defines start script
├── scripts/
│   ├── start.mjs         # setup server + paperclip launcher + Codex device auth
│   └── setup.html        # setup UI
└── README.md
```

---

## After first launch

Once Paperclip is running, normal traffic is proxied through to `paperclipai run`. The setup routes remain available for management, but the root app behaves like a normal Paperclip deployment.

If you connected Codex through device auth, the saved ChatGPT/Codex Plan session lives under `/paperclip/.codex` on the attached volume.

---

## Troubleshooting

**Setup page keeps reappearing after redeploy**  
→ The `/paperclip` volume wasn't attached. Make sure the volume is mounted at `/paperclip` in Railway's service settings.

**Codex Plan login is disabled**  
→ Set `PAPERCLIP_SETUP_PASSWORD` first. The wrapper requires it before showing the device verification URL and one-time code.

**Codex login doesn't stay signed in after restart**  
→ Make sure the `/paperclip` volume is attached. Codex auth is stored under `/paperclip/.codex`.

**Codex device login fails immediately**  
→ Device-code login must be enabled for the ChatGPT account or workspace you're using. If it isn't available, use browser login elsewhere and copy the auth cache, or fall back to `OPENAI_API_KEY`.

**Auth errors / blank screen after login**  
→ `PAPERCLIP_PUBLIC_URL` and `PAPERCLIP_ALLOWED_HOSTNAMES` don't match your Railway domain. Update them and redeploy.

**`DATABASE_URL` SSL errors**  
→ Add `DATABASE_SSL_REJECT_UNAUTHORIZED=false` to your Railway env vars.

**Paperclip starts but agents can't connect**  
→ Make sure `PAPERCLIP_DEPLOYMENT_EXPOSURE=public` is set so the server accepts external connections.
