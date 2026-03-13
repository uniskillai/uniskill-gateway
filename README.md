# UniSkill Gateway 🚀

> **The Universal AI Tool Layer.** Registry-driven, edge-optimized, and built for the Agentic era. Unified execution for every tool your agent needs.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/uniskillai/uniskill-gateway)

---

## Architecture Overview

UniSkill Gateway acts as the bridge between LLM reasoning and deterministic execution. It collapses the complexity of managing API keys, billing, rate-limiting, and data formatting into a single, high-performance edge service.

At its core, UniSkill is a **Registry-Driven Engine**.

### Key Capabilities

- 🧩 **Unified Protocol** — Every skill follows a standardized pattern: `skill_name`, `display_name`, `cost_per_call`.
- 📚 **Registry-Driven** — Skills are managed as Markdown definitions in the central registry. The gateway automatically resolves execution logic and billing rates from these definitions.
- ⚡ **Edge-Optimized** — Built on Cloudflare Workers with multi-layered caching (In-Memory + KV) to ensure sub-millisecond execution overhead.
- 💰 **Built-in Billing** — Real-time credit deduction and user identity management, with asynchronous synchronization to persistent databases.
- 🧼 **Plugin Formatters** — Native support for `plugin_hook` logic to clean, compress, and format upstream API results for LLM context optimization.

---

## Unified Execution Protocol

UniSkill standardizes how tools are defined and invoked across the entire ecosystem:

| Field | Description |
|-------|-------------|
| `skill_name` | The semantic unique identifier (e.g., `uniskill_weather`). |
| `display_name` | Human-readable name for UI display (e.g., `Global Weather`). |
| `cost_per_call` | Credits deducted per successful execution. |
| `tags` | Labels for skill categorization and discovery. |

---

## Usage

### 1. Execute a Skill

Instead of managing multiple endpoints, every tool is accessible via the unified execution route:

```bash
curl -X POST https://your-gateway.workers.dev/v1/execute \
  -H "Authorization: Bearer us-xxxx" \
  -d '{
    "skill_name": "uniskill_search",
    "params": {
      "query": "UniSkill architecture benefits"
    }
  }'
```

### 2. Standardized Response

Every execution returns a consistent structure, including usage and billing metadata:

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

## Core Systems

### 🛡️ Error Attribution
Upstream failures (429s, 404s, 500s) are intercepted and translated into professional, actionable feedback. **Credits are only deducted for successful executions.**

### 💨 Layered Caching
- **Memory Cache**: 60s TTL for active user session data to minimize latency.
- **KV Store**: Global persistence for skill configurations and user states.
- **Registry Sync**: Automatic fallback and write-back for skill registration.

### 🔐 Credential Management
Enterprise API keys and secrets are managed securely within the gateway environment, preventing client-side exposure and protecting against prompt injection.

---

## Project Structure

```
uniskill-gateway/
├── src/
│   ├── engine/
│   │   ├── executor.ts    # Generic Proxy & Official executor
│   │   └── parser.ts      # Registry YAML parser
│   ├── routes/
│   │   ├── execute-skill.ts # Unified Entry Point (The Brain)
│   │   └── <native>.ts    # Hardcoded native skill handlers
│   ├── utils/
│   │   ├── billing.ts     # In-memory + KV credit management
│   │   ├── stats.ts       # Supabase RPC logging with denormalization
│   │   └── response.ts    # Standardized response helpers
└── wrangler.toml          # Environment & Bindings
```

---

## Extending the Gateway

Adding a new tool is straightforward:

1. **Registry Integration**: Add a `.md` definition to the Registry. The gateway will instantly detect and support it via `/v1/execute`.
2. **Native Implementation**: For logic-heavy tools, implement a dedicated route and register it in `HARDCODED_NATIVE_SKILLS`.

---

## Enterprise Ready

- **Stable UID**: Maps API Keys to persistent User UIDs for cross-platform history.
- **Denormalized Logs**: Every call logs the `skill_name` and `display_name`快照 for instant bill rendering.
- **Rate-Limiting**: Tier-based RPM limits enforced at the edge.

---

## Self-Hosting & Deployment

### Prerequisites
- Node.js ≥ 18
- [Cloudflare Workers](https://dash.cloudflare.com) account
- [Supabase](https://supabase.com) project for persistent logging

### Deployment

```bash
# 1. Initialize KV
npx wrangler kv:namespace create UNISKILL_KV

# 2. Configure Secrets
npx wrangler secret put TAVILY_API_KEY
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_ANON_KEY

# 3. Deploy to Edge
npm run deploy
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
