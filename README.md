# 🚉 Hermes Station

> **The complete workspace for Hermes Agent & WebUI.**

Hermes Station is an all-in-one workspace that combines [Hermes Agent](https://nousresearch.com) and [Hermes WebUI](https://github.com/nesquena/hermes-webui) into a single interface, making it easy to deploy, manage, and interact with your AI agent from one place.

Created by [@umair554](https://github.com/umair554)

---

## ✨ Features

- 🤖 **Hermes Agent** — full Hermes gateway + dashboard in one container
- 💬 **Hermes WebUI** — primary chat interface served at `/`
- 📊 **Status Dashboard** — at `/hm` to monitor all services
- 🔒 **Unified auth** — single `GATEWAY_TOKEN` gates everything
- 💾 **HF Dataset backup** — automatic state persistence across restarts
- 📱 **Telegram integration** — webhook-based bot support
- 🖥️ **Desktop app support** — stable session token for the Hermes desktop app

---

## 🚀 Deploy on Hugging Face Spaces

[![Duplicate this Space](https://huggingface.co/datasets/huggingface/badges/resolve/main/duplicate-this-space-md.svg)](https://huggingface.co/spaces/YOUR_SPACE_LINK_HERE?duplicate=true)

> Replace `YOUR_SPACE_LINK_HERE` with the actual Space URL before sharing.

---

## ⚙️ Required Environment Variables

Set these under **Settings → Variables and secrets** in your Hugging Face Space:

| Variable | Required | Description |
|---|---|---|
| `GATEWAY_TOKEN` | **Yes** | Your secret token. Gates access to the dashboard, status page, and `/v1` API. Choose a strong random string. |
| `HF_TOKEN` | Recommended | Your Hugging Face token (read/write). Enables automatic state backup to a private HF Dataset so your sessions, profiles, and settings survive Space restarts. |
| `LLM_API_KEY` | **Yes** | API key for your LLM provider (e.g. OpenAI, Anthropic, etc.). |
| `LLM_MODEL` | **Yes** | Model identifier to use (e.g. `gpt-4o`, `claude-3-5-sonnet-20241022`, `meta-llama/Llama-3.3-70B-Instruct`). |

### Optional Variables

| Variable | Default | Description |
|---|---|---|
| `BACKUP_DATASET_NAME` | `hermes-station-backup` | Name of the private HF Dataset used for state backup. |
| `HF_USERNAME` | *(auto)* | Your HF username. Auto-detected from `HF_TOKEN` if not set. |
| `TELEGRAM_BOT_TOKEN` | — | Enables Telegram bot integration via webhook. |
| `HERMES_DASHBOARD_SESSION_TOKEN` | *(derived)* | Override the session token for the Hermes desktop app. Normally derived deterministically from `GATEWAY_TOKEN`. |
| `SYNC_INTERVAL` | `60` | Maximum seconds between state backups. |
| `GATEWAY_ALLOW_ALL_USERS` | `true` | Allow all users to access the WebUI (pre-set in this image). |

---

## 🔗 URL Structure

Once deployed, your Space exposes these routes:

| Path | Description |
|---|---|
| `/` | Hermes WebUI (primary chat interface) |
| `/hm` | Hermes Station status dashboard (requires `GATEWAY_TOKEN`) |
| `/hm/app` | Hermes dashboard (full agent management UI) |
| `/v1` | OpenAI-compatible API endpoint (bearer auth) |
| `/health` | Health check (unauthenticated, for HF probes) |
| `/telegram` | Telegram webhook receiver |

---

## 📦 What's Inside

```
Hermes Station
├── Hermes Agent (NousResearch)   — gateway + dashboard on internal ports
├── Hermes WebUI (nesquena)       — chat UI served as primary interface
├── health-server.js              — single-port router on port 7861
├── start.sh                      — orchestration + service supervisor
└── hermes-sync.py                — HF Dataset backup/restore
```

---

## 🛡️ Security Notes

- `GATEWAY_TOKEN` is the only credential needed to access the full UI and API. Keep it secret.
- `HF_TOKEN` should have **write** access to create the backup dataset.
- `LLM_API_KEY` is stored as a Space Secret and never backed up to the dataset.
- The Telegram webhook secret is generated locally and never synced to the backup dataset.

---

## 📄 License

MIT — see [LICENSE](LICENSE) for details.
