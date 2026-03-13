# UniSkill Gateway 🚀

> **The Universal AI Tool Layer.** Registry-driven, edge-optimized, and built for the Agentic era. Unified execution for every tool your agent needs.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/uniskillai/uniskill-gateway)

---

## The Vision: UniSkill 2.0

Building AI agents requires a bridge between LLM reasoning and deterministic execution. **UniSkill Gateway** collapses the complexity of managing API keys, billing, rate-limiting, and data formatting into a single, unified protocol.

With **UniSkill 2.0**, your gateway is no longer just a proxy — it's a **Registry-Driven Engine**.

---

## What makes UniSkill 2.0 unique?

UniSkill is a **managed tool execution gateway** built on Cloudflare's global edge network.

- 🧩 **Unified Protocol** — Every skill follows the same pattern: `skill_name`, `display_name`, `cost_per_call`.
- 📚 **Registry-Driven** — Skills are defined as Markdown files in the [UniSkill Registry](https://github.com/uniskillai/uniskill-web/tree/main/registry/skills). Upload a file, and the gateway automatically knows how to execute and bill for it.
- ⚡ **Edge-Optimized** — Built on Cloudflare Workers with multi-layered caching (In-Memory + KV) for sub-millisecond overhead.
- 💰 **Prepaid Credit System** — Real-time deduction from a stable user identity, synchronized with Supabase for historical auditing.
- 🧼 **Plugin Formatters** — Built-in `plugin_hook` support to clean and compress upstream API results for LLM context tokens.

---

## Implementation Protocol

UniSkill 2.0 standardizes how tools are defined and invoked:

| Field | Description |
|-------|-------------|
| `skill_name` | The semantic unique identifier (e.g., `uniskill_weather`). |
| `display_name` | Human-readable name for UI/UX (e.g., `Global Weather`). |
| `cost_per_call` | Credits deducted per successful execution. |
| `tags` | Array of labels for categorization and discovery. |

---

## Quickstart

### 1. Unified Execution Call

Forget per-endpoint management. Use the unified execution route:

```bash
curl -X POST https://your-gateway.workers.dev/v1/execute \
  -H "Authorization: Bearer us-xxxx" \
  -d '{
    "skill_name": "uniskill_search",
    "params": {
      "query": "UniSkill 2.0 architecture"
    }
  }'
```

### 2. Standardized Response

Every response is wrapped with UniSkill usage metadata:

```json
{
  "success": true,
  "...": "Skill-specific data here",
  "_uniskill": {
    "cost": 1.0,
    "remaining": 98.5,
    "request_id": "89abcdef12345678-SIN",
    "version": "v1.0.0"
  }
}
```

---

## Core Features

### 🛡️ Graceful Error Attribution
Raw upstream errors (429s, 404s, 500s) are intercepted and translated into professional, actionable feedback. Credits are only deducted for successful executions.

### 💨 Layered Caching
- **Level 1 (In-Memory)**: 60s TTL for hot user session data (UID/Credits).
- **Level 2 (KV Store)**: Global persistence for skill configurations and user state.
- **Level 3 (Registry API)**: Automatic fallback for new skill registration.

### 🔐 Multi-Credential Pooling
Enterprise keys (Tavily, Jina, Mapbox, etc.) are managed securely in Cloudflare Secrets, protected from LLM prompt injection or client-side leakage.

---

## Project Structure

```
uniskill-gateway/
├── src/
│   ├── engine/
│   │   ├── executor.ts    # Generic Proxy/Official executor
│   │   └── parser.ts      # Registry YAML parser
│   ├── routes/
│   │   ├── execute-skill.ts # Unified Entry Point (The Brain)
│   │   └── <native>.ts    # Hardcoded native skill handlers
│   ├── utils/
│   │   ├── billing.ts     # In-memory + KV credit management
│   │   ├── stats.ts       # Supabase RPC logging with denormalization
│   │   └── response.ts    # Standardized JSON helpers
└── wrangler.toml          # Environment & Bindings
```

---

## How to Add a New Skill

Unlike traditional gateways, you don't always need to write code.

1. **Registry Method (Recommended)**: Create a `.md` file in the Registry. Define the `endpoint`, `method`, and `payload` mapping. Run the sync script. The gateway will instantly support it via `/v1/execute`.
2. **Native Method**: For complex logic (like `uniskill_math`), create a new route file and register it in `HARDCODED_NATIVE_SKILLS` within `execute-skill.ts`.

---

## Enterprise Ready

- **Stable UID**: Maps API Keys to persistent User UIDs for cross-platform history.
- **Denormalized Logs**: Every call logs the `skill_name` and `display_name`快照 for instant bill rendering.
- **Rate-Limiting**: Tier-based RPM limits enforced at the edge.

---

## Self-Hosting

### Prerequisites
- Node.js ≥ 18
- A [Cloudflare account](https://dash.cloudflare.com)
- A [Supabase project](https://supabase.com) (for logs and user tiering)

### Deploy in 4 Steps

```bash
# 1. Create KV namespaces
npx wrangler kv:namespace create UNISKILL_KV
# → Paste the returned ID into wrangler.toml

# 2. Set your Secrets
npx wrangler secret put TAVILY_API_KEY
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_ANON_KEY

# 3. Deploy
npm run deploy

# 4. Sync Registry (From uniskill-web)
# This populates your KV and DB with all official skills
npm run sync-registry
```

### Local Development

```bash
# 1. Create .dev.vars in project root
echo "TAVILY_API_KEY=tvly-xxxxxxxx" > .dev.vars
echo "SUPABASE_URL=https://xxxx.supabase.co" >> .dev.vars
echo "SUPABASE_ANON_KEY=xxxx" >> .dev.vars

# 2. Run local server
npm run dev   # Starts at http://localhost:8787
```

---

## License

MIT © UniSkill
