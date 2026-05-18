# Noesaa Meridian — AGENTS.md

## Project Overview
AI-powered DLLM Solana liquidity management agent.

This project uses:
- Node.js
- PM2
- Meteora DLMM
- OpenRouter / MiMo / LLM orchestration
- Telegram operations
- Autonomous screening and management agents

---

## Development Rules

### Safety First
- Never expose secrets
- Never commit .env
- Never hardcode wallet keys
- Never bypass DRY_RUN safeguards
- Never remove deploy guards

### Development Workflow
- Work on `dev` branch by default
- `main` is stable only
- Experimental/high-risk work goes to `experimental`

### Architecture Priorities
1. Reliability
2. State consistency
3. Decision explainability
4. Logging clarity
5. Risk management
6. Performance optimization

### Current Priorities
- Fix paper trading reliability
- Remove `current: ?%` state bug
- Improve peak confirmation handling
- Improve decision logs
- Improve deploy rejection reasoning
- Improve state persistence

### Do Not Add Yet
- Multi-wallet systems
- Auto strategy mutation
- High-frequency trading logic
- Complex distributed infra
- Database migration
- Redis/queues
- Websocket infra

Keep architecture lightweight and inspectable.

---

## Important Files

- `index.js` → runtime orchestration
- `agent.js` → ReAct loop
- `state.js` → persistent state
- `pool-memory.js` → pool learning memory
- `decision-log.js` → deployment reasoning
- `lessons.js` → learning system
- `tools/dlmm.js` → Meteora execution layer

---

## Runtime Philosophy

The agent must:
- prefer survival over aggressiveness
- reject low-quality pools
- explain decisions clearly
- avoid blind deployments
- remain deterministic under failure conditions

---

## Deployment Policy

Development happens locally.

Production deployment flow:
local → GitHub → VPS

Never develop directly on VPS.