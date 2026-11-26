# DeepMarket Architecture Decision Record (Phase 0 Baseline)

- **Project**: DeepMarket (Fusion remake of DeepFish & FishLottery)
- **Status**: Locked at Phase 0 (2026-11-26)

## Core Decisions

1. **Dual-Engine Fishing Formula (Option C)**:
   - Equipment side adopts DeepFish's 6-affix component system (`speed`, `technique`, `rarity`, `material`, `size`, `doubleCatch`) paired with FishLottery's strict durability decay, enhancement, and auto-repair mechanics.
   - Catch side retains FishLottery's 8 fish trait tags (`swift`, `armored`, `luminous`, `heavy`, `ancient`, `surge`, `abyssal`, `prismatic`) so every catch can feed both standard sale and DeepSea FX trait supply/demand.
2. **Dual-Track Offline Rewards (Option C)**:
   - Primary fishing adopts FishLottery's 12-hour offline catch-up cap (constrained by rod durability and auto-repair funds).
   - Fish house / drying rack idle yields are calculated independently.
3. **Economy & Market Balance**:
   - Dual-track economy: Basic Guild/Chamber (standard fish & materials) + DeepSea FX K-line Exchange (trait supply/demand, imbalance ratio, ±10% daily limit, mean reversion).
   - Black Market (purple coins & super scratch cards) and C2C player market are planned and supported in schema, with pacing & numerical balance tuned by Neon.
4. **PostgreSQL Hybrid Authoritative Model**:
   - All RNG, durability, K-line pricing, lottery draws, and scratch card payouts are strictly server-authoritative in Go + PostgreSQL.
   - Independent `users` (`scrypt` password hashes) & `sessions`, `players` with optimistic concurrency `version` and asset revision `inv_rev`, plus relational tables for inventory, equipment, FX market, lottery, scratch cards, orders, idempotent `action_log`, and `asset_ledger`.
5. **Algorithm Rewrite**:
   - UTC-based canonical FX settlement and server-authoritative lottery batch draws rewritten cleanly in Go.
6. **Frontend Rewrite (Phase 5)**:
   - Complete Vite + React rewrite with `opus 5.5` refactoring the pixel water Canvas scene into React components.
