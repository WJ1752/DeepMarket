# DeepMarket（深海鱼市）

DeepMarket 是一款融合 **DeepFish**（六词缀装备体系）与 **FishLottery**（严谨耐久损耗/自动维修、8 词条供需、深海 FX 交易所、6 小时 UTC 彩票与刮刮乐）玩法的全栈重构作品。后端采用 **Go + PostgreSQL** 服务端权威架构，前端采用 **Vite + React + TypeScript + HTML5 Canvas / SVG** 重构。

---

## 核心特性

- **双引擎钓鱼系统（服务端权威）**
  - 装备侧支持 6 类词缀聚合（`speed`、`technique`、`rarity`、`material`、`size`、`doubleCatch`），结合耐久-张力曲线、拉锯损耗、阈值自动维修与 8 秒冷却控制。
  - 渔获侧支持 6 大海域（`shore`、`shelf`、`open`、`deep`、`rift`、`abyss`）与 8 种词条（`swift`、`armored`、`luminous`、`heavy`、`ancient`、`surge`、`abyssal`、`prismatic`）。
- **高频多路复用 HMAC-SHA256 签名 SSE 网关**
  - `/api/sse/stream` 与 `/api/events` 支持用户私有通道 + `global` 全局传说掉落/开奖广播，每条信封均附带规范化 HMAC-SHA256 签名，支持 `Last-Event-ID` 断线重放与防慢客户端阻塞丢弃。
- **双轨经济体系**
  - **潮汐公会（Tidal Guild）**：按词条组合、稀有度与重量实时报价售鱼，发放鱼币、空白彩票券并向 FX 市场注入负向供给流。
  - **深海 FX 交易所（DeepSea FX）**：8 词条实时盘口、供需失衡比、`±10%` 单日涨跌停与均值回归、UTC 日切结算 Worker，以及支持 `15m / 30m / 60m / 120m` 周期、缩放/平移/十字光标的交互式 K 线图。
- **彩票与刮刮乐闭环**
  - 每 6 小时 UTC（`00/06/12/18`）自动开奖的 3 奖池彩票（普通场 / 高级场 / 大师场），含 `draw_seed_hash` 承诺与 `action_log` 请求幂等。
  - 服务端权威刮刮乐（`潮汐刮刮乐` / `深渊超级刮刮乐`），未刮开前严格脱敏卡面与派奖结果，防重复兑奖。
- **React + 像素海面 Canvas 前端**
  - 独立拆分像素水体渲染层（离屏海域生态缓存、动态海浪/钓手/浮漂与深海海图航线弹窗）、状态同步防回退（`version` / `inv_rev`）以及 5 级 Playwright 端到端测试套件。

---

## 目录结构

```text
FISHMarket/
├── docs/
│   └── ARCHITECTURE_DECISIONS.md      # 宏观架构与双引擎设计基线
├── scripts/
│   └── env.ps1                        # 本地 Go / PostgreSQL 环境变量脚本
├── server/                            # Go 后端 (deepmarket/server)
│   ├── cmd/
│   │   ├── api/main.go                # HTTP + SSE 服务入口（支持托管 web/dist）
│   │   └── migrate/main.go            # 数据库迁移 CLI
│   └── internal/
│       ├── auth/                      # scrypt 密码哈希与随机 Session
│       ├── db/                        # 连接池与嵌入式 SQL 迁移 (0001_phase1_core.sql)
│       ├── fishing/                   # 双引擎钓鱼公式与服务端定时器
│       ├── fx/                        # FX K 线计算、有界历史聚合与日切 Worker
│       ├── lottery/                   # 6h UTC 彩票与刮刮乐结算引擎及 Worker
│       ├── repo/                      # PostgreSQL 事务仓储与 asset_ledger 审计流水
│       ├── sse/                       # HMAC-SHA256 多路复用 SSE Hub
│       └── httpapi/                   # REST API 路由与集成测试
└── web/                               # Vite + React + TypeScript 前端
    ├── src/
    │   ├── api/                       # 类型定义、REST 客户端、SSE 管理器
    │   ├── state/                     # useMarketSync 状态与版本对账
    │   └── components/                # AuthGate、FishingDeck、water/、GuildPanel、FxTerminal、LotteryScratchHall
    └── e2e/                           # Playwright 5 级端到端与视觉审计套件
```

---

## 本地开发与运行

### 1. 环境要求
- **Go** `1.24+`（本地工具链已配置 `1.27.4`）
- **PostgreSQL** `16+`
- **Node.js** `20+` / `npm`

### 2. 数据库迁移与后端测试

```powershell
# 加载本地工具链与数据库环境变量（默认 127.0.0.1:55432 / deepmarket）
. .\scripts\env.ps1

# 执行数据库迁移
Set-Location .\server
go run .\cmd\migrate

# 运行后端静态检查、编译与全量测试
go vet ./...
go build ./...
go test -count=1 -v ./...
```

### 3. 前端构建与启动

```powershell
# 安装依赖并打包生产产物到 web/dist
Set-Location .\web
npm install
npm run build
```

若使用 Vite 开发服务器（自动代理 `/api` 与 `/healthz` 至 `127.0.0.1:8080`）：

```powershell
npm run dev
```

### 4. 启动一体化服务端

```powershell
. .\scripts\env.ps1
$env:DEEPMARKET_ADDR = "127.0.0.1:18080"
$env:DEEPMARKET_WEB_DIST = (Resolve-Path ".\web\dist").Path
$env:DEEPMARKET_HMAC_SECRET = "change-me-in-production"

Set-Location .\server
go run .\cmd\api
```

启动后访问 `http://127.0.0.1:18080`，健康检查接口为 `GET /healthz`。

### 5. 端到端测试（Playwright E2E）

在服务端运行期间，可在 `web/e2e` 下执行 5 级黑盒与白盒对抗端到端测试：

```powershell
Set-Location .\web\e2e
node .\run.mjs --tier all
```
