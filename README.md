# UniSkill Gateway 🚀

> **The Universal AI Tool Layer.** A registry-driven, edge-optimized execution engine for AI agents. One API key unlocks web search, scraping, weather, charts, and any tool you build — via REST or MCP.



## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      CLIENT LAYER                           │
│        REST API (/v1/execute)  ·  MCP SSE (/v1/mcp/sse)   │
└────────────────────┬──────────────────────┬────────────────┘
                     │                      │
                     ▼                      ▼
┌─────────────────────────────────────────────────────────────┐
│              GATEWAY ENTRY  (src/index.ts)                  │
│           Versioned Router · CORS · Auth Pre-check          │
└────────────────────┬──────────────────────┬────────────────┘
                     │                      │
         ┌───────────▼──────────┐  ┌────────▼────────────────┐
         │   execute-skill.ts   │  │  MCPSession (Durable DO) │
         │  Auth → Rate Limit   │  │  SSE Stream · tools/list │
         │  Experience Inject   │  │  tools/call · 5s HB     │
         │  Execute → Bill      │  │  Identity Lock          │
         └──────────┬───────────┘  └─────────────────────────┘
                    │
       ┌────────────┼─────────────────┐
       ▼            ▼                 ▼
┌────────────┐ ┌──────────────┐ ┌──────────────────────┐
│ KV Registry│ │   Executor   │ │   Native Handlers    │
│ 3-Tier:    │ │  Declarative │ │  weather · scrape    │
│ private    │ │  Template +  │ │  math · time · geo   │
│ official   │ │  Secrets     │ │  crypto · chart      │
│ market     │ └──────────────┘ │  github-tracker      │
└────────────┘                  └──────────────────────┘
```

---

## Quick Start

```bash
# Install dependencies
npm install

# Add secrets to .dev.vars (see Deployment section for full list)
echo "SUPABASE_URL=https://xxxx.supabase.co" > .dev.vars

# Run local dev server (remote KV/DO access)
npm run dev   # → http://localhost:8787
```

---



### Environment Variables (wrangler.toml)

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Supabase project URL |
| `VERCEL_WEBHOOK_URL` | Credit sync webhook (`uniskill-web`) |
| `WEB_DOMAIN` | Frontend domain (`https://uniskill.ai`) |
| `MAPBOX_API_KEY` | Geocoding upstream |

### Deploy

```bash
npm run deploy -- --env=""        # Production
npm run deploy -- --env=staging   # Staging
```

---

## Documentation

Full internals are documented in [`/docs`](./docs):

| Doc | Description |
|-----|-------------|
| [Execution Pipeline](./docs/internals/execution-pipeline.mdx) | 8-step auth → bill → telemetry flow |
| [Skill Registry](./docs/internals/skill-registry.mdx) | 3-tier KV structure & Unified JSON format |
| [Billing & Telemetry](./docs/internals/billing-telemetry.mdx) | Credit deduction & dual async logging chains |
| [MCP Protocol](./docs/internals/mcp-protocol.mdx) | Durable Object SSE session architecture |

Public API docs: **[docs.uniskill.ai](https://docs.uniskill.ai)**

---

## License

MIT © UniSkill
