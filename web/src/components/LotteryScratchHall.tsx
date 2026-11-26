import {
  Check,
  Clock3,
  Coins,
  Copy,
  Eye,
  EyeOff,
  Gem,
  Sparkles,
  Ticket,
  Trophy,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, PointerEvent as ReactPointerEvent } from 'react'
import { ApiError, createRequestKey, errorMessage, sessionApi } from '../api/client'
import { MATERIAL_META, ROD_NAMES } from '../api/presentation'
import type {
  LotteryClaimResponse,
  LotteryCraftResponse,
  LotteryDraw,
  LotteryPool,
  LotteryStatusResponse,
  LotteryTicket,
  PrizeItem,
  PublicPlayer,
  PublicScratchCard,
  ScratchCardType,
  ScratchPayout,
  ScratchSlot,
} from '../api/types'
import './auth-hall.css'

export interface LotteryScratchHallProps {
  lottery: LotteryStatusResponse | null
  cards: PublicScratchCard[]
  walletCoins: number
  canDrawBatch: boolean
  onPlayerUpdate: (player: PublicPlayer) => void
  onRefreshLottery: () => Promise<void>
  onClaimed: (res: LotteryClaimResponse) => void
  onCrafted?: (res: LotteryCraftResponse) => void
  onScratchCardUpdate: (card: PublicScratchCard, player?: PublicPlayer) => void
}

interface ScratchTypeMeta {
  id: ScratchCardType
  name: string
  cost: number
  slots: number
  need: number
  tagline: string
}

const SCRATCH_TYPES: readonly ScratchTypeMeta[] = [
  {
    id: 'scratch-tide',
    name: '潮汐刮刮乐',
    cost: 30,
    slots: 3,
    need: 2,
    tagline: '3 格卡面 · 任意 2 格相同即中奖',
  },
  {
    id: 'scratch-super',
    name: '深渊超级刮刮乐',
    cost: 120,
    slots: 9,
    need: 3,
    tagline: '9 格卡面 · 任意 3 格相同即成组（支持多组叠加）',
  },
]

const SCRATCH_REVEAL_THRESHOLD = 0.45
const SCRATCH_BRUSH_RADIUS = 18
const SCRATCH_GRID_STEP = 8
const SETTLE_POLL_INTERVAL_MS = 10_000
const SETTLE_POLL_MAX = 4

const utcDate = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
  hourCycle: 'h23',
})
const numberFormat = new Intl.NumberFormat('zh-CN')

function formatUTC(value: string): string {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? `${utcDate.format(parsed)} UTC` : value || '—'
}

function chooseBigInt(n: number, k: number): bigint {
  if (k < 0 || k > n) return 0n
  let result = 1n
  for (let i = 1; i <= k; i += 1) {
    result = (result * BigInt(n - k + i)) / BigInt(i)
  }
  return result
}

function hitProbability(pool: LotteryPool, hits: number): number {
  const total = Math.max(1, pool.max - pool.min + 1)
  const pick = Math.max(1, pool.pick)
  const denominator = chooseBigInt(total, pick)
  if (denominator === 0n) return 0
  const ways = chooseBigInt(pick, hits) * chooseBigInt(total - pick, pick - hits)
  return Number(ways) / Number(denominator)
}

function formatProbability(chance: number): string {
  if (!Number.isFinite(chance) || chance <= 0) return '—'
  if (chance >= 0.01) return `${(chance * 100).toFixed(2)}%`
  if (chance >= 0.0001) return `${(chance * 100).toFixed(4)}%`
  const oneIn = Math.round(1 / chance)
  return `1 / ${numberFormat.format(oneIn)}`
}

function prizeName(prize: PrizeItem): string {
  if (prize.type === 'coin') return `${numberFormat.format(prize.qty)} 金币`
  if (prize.rod_id) {
    const rodLabel = ROD_NAMES[prize.rod_id] ?? prize.rod_id
    return `${rodLabel} × ${numberFormat.format(prize.qty)}`
  }
  const matKey = prize.name ?? prize.type
  const matLabel = MATERIAL_META[matKey]?.name ?? matKey
  return `${matLabel} × ${numberFormat.format(prize.qty)}`
}

function prizeTone(prize: PrizeItem): 'coin' | 'rod' | 'material' {
  if (prize.type === 'coin') return 'coin'
  if (prize.rod_id || prize.type === 'rod') return 'rod'
  return 'material'
}

function scratchSlotLabel(kind: string, name: string): string {
  if (kind === 'coin') return '金币'
  return MATERIAL_META[name]?.name ?? name
}

function scratchGroupKey(slot: ScratchSlot): string {
  const need = Math.max(2, Math.round(Number(slot.need) || 2))
  return `${slot.kind || 'material'}:${slot.name}:${slot.qty || 1}:${need}`
}

function getWinningSlotFlags(face: readonly ScratchSlot[]): boolean[] {
  const counts = new Map<string, { count: number; need: number }>()
  for (const slot of face) {
    if (!slot?.name) continue
    const key = scratchGroupKey(slot)
    const need = Math.max(2, Math.round(Number(slot.need) || 2))
    const entry = counts.get(key)
    if (entry) {
      entry.count += 1
    } else {
      counts.set(key, { count: 1, need })
    }
  }
  return face.map((slot) => {
    if (!slot?.name) return false
    const entry = counts.get(scratchGroupKey(slot))
    return Boolean(entry && entry.count >= entry.need)
  })
}

async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      /* Fallback to execCommand below */
    }
  }
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.left = '-9999px'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}

function NumberBalls({ numbers, winning = [] }: { numbers: readonly number[]; winning?: readonly number[] }) {
  const safeNumbers = numbers ?? []
  const safeWinning = winning ?? []
  return (
    <div className="lottery-numbers" aria-label={`号码 ${safeNumbers.join('、')}`}>
      {safeNumbers.map((number, index) => (
        <span
          key={`${number}-${index}`}
          className={safeWinning.includes(number) ? 'number-matched' : undefined}
        >
          {number}
        </span>
      ))}
    </div>
  )
}

function BatchCountdown({
  batchId,
  endAt,
  drawn,
  onRefresh,
}: {
  batchId: string
  endAt: string
  drawn: boolean
  onRefresh: () => Promise<void>
}) {
  const [now, setNow] = useState(() => Date.now())
  const onRefreshRef = useRef(onRefresh)
  const immediateRef = useRef<string | null>(null)

  useEffect(() => {
    onRefreshRef.current = onRefresh
  }, [onRefresh])

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [])

  const endMs = Date.parse(endAt)
  const validEnd = Number.isFinite(endMs)
  const remaining = validEnd ? Math.max(0, Math.ceil((endMs - now) / 1000)) : 0
  const atZero = validEnd && remaining === 0

  useEffect(() => {
    if (!atZero || drawn) return
    if (immediateRef.current !== batchId) {
      immediateRef.current = batchId
      void onRefreshRef.current()
    }
    let polls = 0
    const pollTimer = window.setInterval(() => {
      polls += 1
      if (polls > SETTLE_POLL_MAX) {
        window.clearInterval(pollTimer)
        return
      }
      void onRefreshRef.current()
    }, SETTLE_POLL_INTERVAL_MS)
    return () => window.clearInterval(pollTimer)
  }, [atZero, batchId, drawn])

  const hours = Math.floor(remaining / 3600)
  const minutes = Math.floor((remaining % 3600) / 60)
  const seconds = remaining % 60
  const clockText = validEnd
    ? [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':')
    : '--:--:--'

  let statusClass = 'lottery-status-active'
  let statusLabel = '本轮进行中'
  if (drawn) {
    statusClass = 'lottery-status-drawn'
    statusLabel = '本轮已开奖'
  } else if (atZero) {
    statusClass = 'lottery-status-settling'
    statusLabel = '等待开奖结算…'
  }

  return (
    <div className="lottery-batch-clock">
      <Clock3 size={18} aria-hidden="true" />
      <span className="lottery-countdown" role="timer">
        {clockText}
      </span>
      <span className={`lottery-status-pill ${statusClass}`}>{statusLabel}</span>
    </div>
  )
}

function PoolCard({
  pool,
  blankTickets,
  closed,
  pending,
  onCraft,
}: {
  pool: LotteryPool
  blankTickets: number
  closed: boolean
  pending: boolean
  onCraft: (quantity: number) => void
}) {
  const [quantity, setQuantity] = useState('1')
  const max = pool.ticket_cost > 0 ? Math.floor(Math.max(0, blankTickets) / pool.ticket_cost) : 0
  const count = Number(quantity)
  const valid = Number.isSafeInteger(count) && count > 0 && count <= max
  const cost = valid ? count * pool.ticket_cost : pool.ticket_cost
  const missingForOne = Math.max(0, pool.ticket_cost - Math.max(0, blankTickets))

  useEffect(() => {
    if (max < 1) {
      if (quantity !== '1') setQuantity('1')
      return
    }
    const parsed = Number(quantity)
    if (Number.isFinite(parsed) && parsed > max) {
      setQuantity(String(max))
    }
  }, [max, quantity])

  const prizeRows = useMemo(() => {
    const safePrizes = pool.prizes ?? []
    return safePrizes
      .map((prizes, hits) => ({
        hits,
        prizes: prizes ?? [],
        odds: formatProbability(hitProbability(pool, hits)),
      }))
      .reverse()
  }, [pool])

  function craft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!pending && !closed && valid) onCraft(count)
  }

  return (
    <article className={`lottery-pool lottery-pool-${pool.id}`}>
      <div className="hall-card-title">
        <Ticket size={20} aria-hidden="true" />
        <div>
          <h3>{pool.name}</h3>
          <p>
            {pool.min}–{pool.max} 中选 {pool.pick} 个号码
          </p>
        </div>
      </div>

      <div className="lottery-pool-meta">
        <p className="lottery-cost">
          每张消耗 <strong>{pool.ticket_cost}</strong> 张空白券
        </p>
        <span className={`lottery-affordability${max > 0 ? ' is-affordable' : ' is-short'}`}>
          {max > 0 ? `可制 ${numberFormat.format(max)} 张` : `差 ${numberFormat.format(missingForOne)} 张空白券`}
        </span>
      </div>

      <details className="lottery-prizes">
        <summary>查看奖表与中奖概率</summary>
        <div className="lottery-prize-rows">
          {prizeRows.length === 0 ? (
            <p className="lottery-prize-empty">暂无奖表配置</p>
          ) : (
            prizeRows.map((row) => (
              <div key={row.hits} className="lottery-prize-row">
                <div className="lottery-prize-hit">
                  <strong>命中 {row.hits}</strong>
                  <small>{row.odds}</small>
                </div>
                <div className="lottery-prize-items">
                  {row.prizes.length === 0 ? (
                    <span className="lottery-prize-none">—</span>
                  ) : (
                    row.prizes.map((item, idx) => (
                      <span
                        key={`${row.hits}-${idx}-${item.type}`}
                        className={`lottery-prize-chip lottery-prize-${prizeTone(item)}`}
                        title={item.name ? MATERIAL_META[item.name]?.description : undefined}
                      >
                        {prizeName(item)}
                      </span>
                    ))
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </details>

      <div className="lottery-presets" role="group" aria-label={`${pool.name}快捷数量`}>
        {[1, 5].map((preset) => (
          <button
            key={preset}
            type="button"
            className={`lottery-preset-btn${count === preset ? ' is-active' : ''}`}
            disabled={closed || pending || max < preset}
            onClick={() => setQuantity(String(preset))}
          >
            {preset} 张
          </button>
        ))}
        <button
          type="button"
          className={`lottery-preset-btn${max > 0 && count === max ? ' is-active' : ''}`}
          disabled={closed || pending || max < 1}
          onClick={() => setQuantity(String(Math.max(1, max)))}
        >
          最大 ({numberFormat.format(max)})
        </button>
      </div>

      <form className="lottery-craft" onSubmit={craft}>
        <input
          aria-label={`${pool.name}制券数量`}
          type="number"
          min={1}
          max={max || undefined}
          step={1}
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          disabled={closed || pending || max < 1}
          required
        />
        <button
          type="submit"
          className="button button-quiet"
          disabled={closed || pending || !valid}
        >
          制作号码券
        </button>
      </form>

      <p className="lottery-craft-cost">
        {closed
          ? '本轮已开奖封盘，等待下一轮开启'
          : max > 0
            ? `消耗 ${numberFormat.format(cost)} / ${numberFormat.format(blankTickets)} 空白券`
            : '可通过潮汐公会售鱼获赠空白券'}
      </p>
    </article>
  )
}

function TicketCard({
  ticket,
  pool,
  draw,
  currentBatch,
}: {
  ticket: LotteryTicket
  pool: LotteryPool | undefined
  draw: LotteryDraw | undefined
  currentBatch: LotteryStatusResponse['current_batch'] | undefined
}) {
  const safeNumbers = ticket.numbers ?? []
  const winningNumbers = draw?.winning_numbers ?? []
  const hitCount = draw
    ? safeNumbers.filter((num) => winningNumbers.includes(num)).length
    : 0
  const expectedPrizes = draw ? (pool?.prizes?.[hitCount] ?? []) : []

  let badgeClass = 'lottery-badge-pending'
  let badgeLabel = '待开奖'
  if (draw) {
    if (hitCount > 0) {
      badgeClass = 'lottery-badge-win'
      badgeLabel = `命中 ${hitCount} · 可领取`
    } else if (expectedPrizes.length > 0) {
      badgeClass = 'lottery-badge-consolation'
      badgeLabel = '已开奖·参与奖可领'
    } else {
      badgeClass = 'lottery-badge-miss'
      badgeLabel = '已开奖·未中奖'
    }
  } else if (!currentBatch || ticket.batch_id !== currentBatch.batch_id || currentBatch.drawn) {
    badgeClass = 'lottery-badge-settling'
    badgeLabel = '待结算/往期'
  }

  return (
    <li className={`lottery-ticket-item${draw && hitCount > 0 ? ' is-winner' : ''}`}>
      <div className="lottery-ticket-head">
        <strong>{pool?.name ?? ticket.tier}</strong>
        <span className={`lottery-ticket-badge ${badgeClass}`}>{badgeLabel}</span>
      </div>
      <NumberBalls numbers={safeNumbers} winning={draw ? winningNumbers : undefined} />
      {draw && expectedPrizes.length > 0 && (
        <p className="lottery-ticket-preview">
          预计奖励：{expectedPrizes.map(prizeName).join(' · ')}
        </p>
      )}
      <div className="lottery-ticket-foot">
        <time dateTime={ticket.batch_id}>{formatUTC(ticket.batch_id)}</time>
        <span className="lottery-ticket-id">#{ticket.id.slice(0, 8)}</span>
      </div>
    </li>
  )
}

function ScratchCard({
  card,
  pending,
  revealing,
  onReveal,
}: {
  card: PublicScratchCard
  pending: boolean
  revealing: boolean
  onReveal: () => Promise<boolean>
}) {
  const type = SCRATCH_TYPES.find((item) => item.id === card.card_type)
  const isSuper = card.card_type === 'scratch-super'
  const payouts = card.payouts ?? []
  const face = card.face ?? []
  const slotCount = Math.max(1, card.slots || type?.slots || 3)
  const winningFlags = useMemo(() => getWinningSlotFlags(face), [face])

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const drawingRef = useRef(false)
  const prevPointRef = useRef<{ x: number; y: number } | null>(null)
  const revealFiredRef = useRef(false)
  const [scrapeRatio, setScrapeRatio] = useState(0)

  useEffect(() => {
    if (!card.revealed) {
      revealFiredRef.current = false
    }
  }, [card.id, card.revealed])

  const triggerReveal = useCallback(async () => {
    if (card.revealed || pending || revealing || revealFiredRef.current) return
    revealFiredRef.current = true
    const ok = await onReveal()
    if (!ok) {
      revealFiredRef.current = false
    }
  }, [card.revealed, onReveal, pending, revealing])

  useLayoutEffect(() => {
    if (card.revealed) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return

    let initialized = false

    const paint = () => {
      const rect = canvas.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const width = Math.max(1, Math.round(rect.width * dpr))
      const height = Math.max(1, Math.round(rect.height * dpr))
      if (initialized && canvas.width === width && canvas.height === height) return

      let oldCoat: HTMLCanvasElement | null = null
      if (initialized) {
        oldCoat = document.createElement('canvas')
        oldCoat.width = canvas.width
        oldCoat.height = canvas.height
        oldCoat.getContext('2d')?.drawImage(canvas, 0, 0)
      }

      canvas.width = width
      canvas.height = height
      prevPointRef.current = null

      if (oldCoat) {
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.globalCompositeOperation = 'source-over'
        ctx.drawImage(oldCoat, 0, 0, width, height)
        return
      }

      initialized = true
      ctx.setTransform(width / rect.width, 0, 0, height / rect.height, 0, 0)
      ctx.globalCompositeOperation = 'source-over'

      const grad = ctx.createLinearGradient(0, 0, rect.width, rect.height)
      if (isSuper) {
        grad.addColorStop(0, '#5a431f')
        grad.addColorStop(0.5, '#9d793b')
        grad.addColorStop(1, '#4c3818')
      } else {
        grad.addColorStop(0, '#234c58')
        grad.addColorStop(0.5, '#3b7a89')
        grad.addColorStop(1, '#1d404b')
      }
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, rect.width, rect.height)

      ctx.strokeStyle = isSuper ? 'rgba(255, 240, 198, 0.22)' : 'rgba(216, 248, 250, 0.20)'
      ctx.lineWidth = 1.2
      for (let x = -rect.height; x < rect.width + rect.height; x += 12) {
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x + rect.height, rect.height)
        ctx.stroke()
      }

      ctx.strokeStyle = isSuper ? 'rgba(239, 203, 128, 0.5)' : 'rgba(112, 204, 225, 0.45)'
      ctx.lineWidth = 1.5
      ctx.strokeRect(5, 5, Math.max(0, rect.width - 10), Math.max(0, rect.height - 10))

      ctx.fillStyle = isSuper ? 'rgba(255, 244, 214, 0.9)' : 'rgba(229, 248, 250, 0.9)'
      ctx.font = '600 12px Inter, "Segoe UI", "PingFang SC", sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('刮涂金属涂层或点击下方刮开', rect.width / 2, rect.height / 2)
    }

    paint()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(paint)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [card.id, card.revealed, isSuper])

  const scratchAt = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas || card.revealed || pending || revealing || revealFiredRef.current) return
    const rect = canvas.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const x = Math.min(rect.width, Math.max(0, event.clientX - rect.left))
    const y = Math.min(rect.height, Math.max(0, event.clientY - rect.top))
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return

    ctx.setTransform(canvas.width / rect.width, 0, 0, canvas.height / rect.height, 0, 0)
    ctx.globalCompositeOperation = 'destination-out'
    ctx.fillStyle = '#000'
    ctx.strokeStyle = '#000'
    ctx.beginPath()
    if (prevPointRef.current) {
      ctx.lineWidth = SCRATCH_BRUSH_RADIUS * 2
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.moveTo(prevPointRef.current.x, prevPointRef.current.y)
      ctx.lineTo(x, y)
      ctx.stroke()
    } else {
      ctx.arc(x, y, SCRATCH_BRUSH_RADIUS, 0, Math.PI * 2)
      ctx.fill()
    }
    prevPointRef.current = { x, y }

    let cleared = 0
    let total = 0
    try {
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
      for (let py = 0; py < canvas.height; py += SCRATCH_GRID_STEP) {
        for (let px = 0; px < canvas.width; px += SCRATCH_GRID_STEP) {
          total += 1
          if (data[(py * canvas.width + px) * 4 + 3] < 40) cleared += 1
        }
      }
    } catch {
      return
    }
    const ratio = total > 0 ? cleared / total : 0
    setScrapeRatio(ratio)
    if (ratio >= SCRATCH_REVEAL_THRESHOLD) {
      void triggerReveal()
    }
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (card.revealed || pending || revealing) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.preventDefault()
    drawingRef.current = true
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* Pointer capture is optional in some headless environments */
    }
    scratchAt(event)
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return
    event.preventDefault()
    scratchAt(event)
  }

  const endScratch = () => {
    drawingRef.current = false
    prevPointRef.current = null
  }

  const payoutTotals = useMemo(() => {
    let coins = 0
    let combos = 0
    const materials = new Map<string, number>()
    for (const item of payouts) {
      combos += item.combos
      if (item.kind === 'coin') {
        coins += item.qty
      } else {
        const label = scratchSlotLabel(item.kind, item.name)
        materials.set(label, (materials.get(label) ?? 0) + item.qty)
      }
    }
    return {
      coins,
      combos,
      materials: [...materials.entries()],
    }
  }, [payouts])

  const meterPct = Math.min(100, Math.round((scrapeRatio / SCRATCH_REVEAL_THRESHOLD) * 100))

  return (
    <article
      className={`scratch-card ${isSuper ? 'scratch-card-super' : 'scratch-card-tide'}${
        card.revealed ? ' scratch-card-open' : ''
      }${card.revealed && payouts.length > 0 ? ' scratch-card-won' : ''}`}
    >
      <div className="scratch-card-head">
        <div className="hall-card-title">
          <Sparkles size={19} aria-hidden="true" />
          <div>
            <h3>{type?.name ?? card.card_type}</h3>
            <p>
              #{card.id} · {formatUTC(card.created_at)}
            </p>
          </div>
        </div>
        <span
          className={`scratch-card-badge${
            card.revealed
              ? payouts.length > 0
                ? ' is-win'
                : ' is-empty'
              : ' is-sealed'
          }`}
        >
          {card.revealed
            ? payouts.length > 0
              ? `中奖 ${payoutTotals.combos} 组`
              : '已刮开'
            : `刮开 ${meterPct}%`}
        </span>
      </div>

      <div className="scratch-stage">
        <div
          className="scratch-slots"
          aria-label={card.revealed ? '刮奖结果' : `${slotCount} 个封存格`}
        >
          {card.revealed
            ? face.map((slot, index) => {
                const winner = Boolean(winningFlags[index])
                const label = scratchSlotLabel(slot.kind, slot.name)
                return (
                  <div
                    className={`scratch-slot${winner ? ' scratch-slot-winner' : ''}`}
                    key={`${slot.id}-${index}`}
                    style={{ animationDelay: `${(index % 3) * 65 + Math.floor(index / 3) * 45}ms` }}
                  >
                    <strong>{label}</strong>
                    <span>
                      × {numberFormat.format(slot.qty)}
                      {winner ? ' · 成组' : ''}
                    </span>
                  </div>
                )
              })
            : Array.from({ length: slotCount }, (_, index) => (
                <div
                  className="scratch-slot scratch-slot-mystery"
                  key={index}
                  aria-hidden="true"
                >
                  <Gem size={17} />
                  <span>?</span>
                </div>
              ))}
        </div>

        {!card.revealed && (
          <>
            <canvas
              ref={canvasRef}
              className="scratch-foil-canvas"
              aria-label={`刮开第 ${card.id} 号${type?.name ?? card.card_type}涂层`}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={endScratch}
              onPointerCancel={endScratch}
              onLostPointerCapture={endScratch}
              onDragStart={(event) => event.preventDefault()}
            />
            <div className="scratch-foil-meter" aria-hidden="true">
              <span style={{ width: `${meterPct}%` }} />
            </div>
          </>
        )}
      </div>

      {card.revealed ? (
        <div className="scratch-rewards" aria-label="刮奖派奖">
          {payouts.length > 0 ? (
            <>
              <div className="scratch-rewards-summary">
                <Trophy size={14} aria-hidden="true" />
                <span>
                  合计：
                  {payoutTotals.coins > 0 && `${numberFormat.format(payoutTotals.coins)} 金币`}
                  {payoutTotals.coins > 0 && payoutTotals.materials.length > 0 ? ' · ' : ''}
                  {payoutTotals.materials
                    .map(([name, qty]) => `${name} × ${numberFormat.format(qty)}`)
                    .join(' · ')}
                </span>
              </div>
              {payouts.map((prize: ScratchPayout, index) => (
                <p key={`${prize.kind}-${prize.name}-${prize.need}-${index}`}>
                  <strong>
                    {scratchSlotLabel(prize.kind, prize.name)} × {numberFormat.format(prize.qty)}
                  </strong>
                  <span>
                    {prize.count} 格匹配 · {prize.combos} 组奖励
                  </span>
                </p>
              ))}
            </>
          ) : (
            <p className="scratch-rewards-none">本卡未形成中奖组合</p>
          )}
        </div>
      ) : (
        <div className="scratch-card-foot">
          <span className="scratch-hint">刮涂达 45% 自动开奖</span>
          <button
            type="button"
            className="button button-primary"
            disabled={pending || revealing}
            onClick={() => void triggerReveal()}
          >
            {revealing ? '刮开中…' : 'Scratch / 刮开'}
          </button>
        </div>
      )}
    </article>
  )
}

export function LotteryScratchHall({
  lottery,
  cards,
  walletCoins,
  canDrawBatch,
  onPlayerUpdate,
  onRefreshLottery,
  onClaimed,
  onCrafted,
  onScratchCardUpdate,
}: LotteryScratchHallProps) {
  const status = lottery
  const [activeAction, setActiveAction] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [confirmDraw, setConfirmDraw] = useState<string | null>(null)
  const [lastClaim, setLastClaim] = useState<LotteryClaimResponse | null>(null)
  const [expandedHashes, setExpandedHashes] = useState<Record<string, boolean>>({})
  const [copiedHashKey, setCopiedHashKey] = useState<string | null>(null)
  const [cardFilter, setCardFilter] = useState<'all' | 'unrevealed' | 'revealed'>('all')

  const actionRunning = useRef(false)
  const requestKeys = useRef(new Map<string, string>())
  const copyTimerRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current)
    }
  }, [])

  const pools = status?.pools ?? []
  const batch = status?.current_batch
  const tickets = status?.tickets ?? []
  const recentDraws = status?.recent_draws ?? []
  const safeCards = cards ?? []
  const pending = Boolean(activeAction)

  const poolById = useMemo(
    () => new Map(pools.map((pool) => [pool.id, pool])),
    [pools],
  )

  const drawByKey = useMemo(
    () => new Map(recentDraws.map((draw) => [`${draw.batch_id}:${draw.pool_id}`, draw])),
    [recentDraws],
  )

  const claimableCount = useMemo(() => {
    let count = 0
    for (const ticket of tickets) {
      const draw = drawByKey.get(`${ticket.batch_id}:${ticket.tier}`)
      if (!draw) continue
      const hits = (ticket.numbers ?? []).filter((n) => (draw.winning_numbers ?? []).includes(n)).length
      const expected = poolById.get(ticket.tier)?.prizes?.[hits] ?? []
      if (hits > 0 || expected.length > 0) count += 1
    }
    return count
  }, [drawByKey, poolById, tickets])

  const unrevealedCount = useMemo(
    () => safeCards.filter((card) => !card.revealed).length,
    [safeCards],
  )
  const revealedCount = safeCards.length - unrevealedCount
  const filteredCards = useMemo(() => {
    if (cardFilter === 'unrevealed') return safeCards.filter((card) => !card.revealed)
    if (cardFilter === 'revealed') return safeCards.filter((card) => card.revealed)
    return safeCards
  }, [cardFilter, safeCards])

  function poolName(tier: string): string {
    return poolById.get(tier as LotteryPool['id'])?.name ?? tier
  }

  async function perform(
    action: string,
    operation: (requestKey: string) => Promise<string>,
    options?: { refreshOnError?: boolean; revealCardId?: number },
  ): Promise<boolean> {
    if (actionRunning.current) return false
    const requestKey = requestKeys.current.get(action) ?? createRequestKey()
    requestKeys.current.set(action, requestKey)
    actionRunning.current = true
    setActiveAction(action)
    setError('')
    setNotice('')
    try {
      const message = await operation(requestKey)
      requestKeys.current.delete(action)
      setNotice(message)
      return true
    } catch (failure) {
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500) {
        requestKeys.current.delete(action)
      }
      setError(errorMessage(failure))
      if (
        options?.revealCardId !== undefined &&
        failure instanceof ApiError &&
        failure.status === 409
      ) {
        try {
          const synced = await sessionApi.scratchCards()
          const matched = (synced.cards ?? []).find((c) => c.id === options.revealCardId)
          if (matched) {
            onScratchCardUpdate(matched)
          }
        } catch {
          /* Best-effort sync on 409 conflict */
        }
      } else if (options?.refreshOnError !== false) {
        void onRefreshLottery()
      }
      return false
    } finally {
      actionRunning.current = false
      setActiveAction('')
    }
  }

  async function handleCopyHash(rowKey: string, seedHash: string) {
    const ok = await copyToClipboard(seedHash)
    if (!ok) {
      setError('未能复制哈希，请展开后手动复制。')
      return
    }
    setCopiedHashKey(rowKey)
    if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current)
    copyTimerRef.current = window.setTimeout(() => {
      setCopiedHashKey((current) => (current === rowKey ? null : current))
    }, 2000)
  }

  return (
    <div className="lottery-hall">
      <header className="hall-heading">
        <p className="eyebrow">Lottery &amp; Scratch</p>
        <h1>潮汐奖厅</h1>
      </header>

      {notice && (
        <p className="hall-feedback" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="inline-error hall-error" role="alert">
          {error}
        </p>
      )}

      <section className="panel hall-panel" aria-labelledby="lottery-heading">
        <div className="hall-section-title">
          <div>
            <h2 id="lottery-heading">六小时海域彩票</h2>
            <p>每 6 小时（UTC）自动开奖结算一轮</p>
          </div>
          {status && (
            <span className="hall-balance">
              <Ticket size={16} aria-hidden="true" /> 空白券{' '}
              <strong>{numberFormat.format(status.blank_tickets)}</strong>
            </span>
          )}
        </div>

        {batch && (
          <div className="lottery-batch">
            <div className="lottery-batch-meta">
              <span>当前批次</span>
              <strong className="mono">{batch.batch_id}</strong>
              <time dateTime={batch.end_at}>
                周期 {formatUTC(batch.start_at)} – {formatUTC(batch.end_at)}
              </time>
            </div>
            <BatchCountdown
              batchId={batch.batch_id}
              endAt={batch.end_at}
              drawn={batch.drawn}
              onRefresh={onRefreshLottery}
            />
          </div>
        )}

        {status ? (
          <div className="lottery-pools">
            {pools.map((pool) => (
              <PoolCard
                key={pool.id}
                pool={pool}
                blankTickets={status.blank_tickets}
                closed={status.current_batch.drawn}
                pending={pending}
                onCraft={(quantity) =>
                  void perform(`craft-${status.current_batch.batch_id}-${pool.id}-${quantity}`, async (key) => {
                    const result = await sessionApi.craftLottery(pool.id, quantity, key)
                    if (onCrafted) {
                      onCrafted(result)
                    } else {
                      onPlayerUpdate(result.player)
                      void onRefreshLottery()
                    }
                    return `已制作 ${result.tickets.length} 张${pool.name}号码券。`
                  })
                }
              />
            ))}
          </div>
        ) : (
          <p className="empty-state">正在读取抽奖状态…</p>
        )}

        <div className="hall-actions">
          <button
            type="button"
            className="button button-primary"
            disabled={pending || tickets.length === 0}
            onClick={() =>
              void perform('claim', async (key) => {
                const result = await sessionApi.claimLottery(key)
                onClaimed(result)
                setLastClaim(result)
                if (result.claimed === 0) return '暂无可领取的号码券奖励。'
                const prizes = (result.tickets ?? []).flatMap((ticket) => ticket.prizes ?? []).map(prizeName)
                const summary = prizes.length ? ` ${prizes.join(' · ')}` : ''
                return `已结算 ${result.claimed} 张号码券。${summary}`
              })
            }
          >
            Claim All / 领取全部
            {claimableCount > 0 ? ` (${claimableCount})` : ''}
          </button>

          {canDrawBatch && batch && !batch.drawn && (
            confirmDraw === batch.batch_id ? (
              <div className="lottery-confirm" role="group" aria-label="确认提前开奖">
                <p>提前开奖将立即封盘并结算当前批次。</p>
                <button
                  type="button"
                  className="button button-quiet"
                  disabled={pending}
                  onClick={() => {
                    setConfirmDraw(null)
                    void perform(`draw-${batch.batch_id}`, async () => {
                      const result = await sessionApi.drawLottery(batch.batch_id)
                      void onRefreshLottery()
                      return result.newly_drawn ? '本轮已开奖。' : '本轮此前已开奖。'
                    })
                  }}
                >
                  确认开奖
                </button>
                <button
                  type="button"
                  className="button button-quiet"
                  disabled={pending}
                  onClick={() => setConfirmDraw(null)}
                >
                  取消
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="button button-quiet"
                disabled={pending}
                onClick={() => setConfirmDraw(batch.batch_id)}
              >
                Draw Batch / 提前开奖
              </button>
            )
          )}
        </div>

        {lastClaim && (
          <div className="lottery-claim-receipt" role="status" aria-label="领奖回执">
            <div className="lottery-claim-receipt-head">
              <strong>
                <Trophy size={16} aria-hidden="true" />
                {lastClaim.claimed > 0
                  ? `领奖回执 · 已结算 ${lastClaim.claimed} 张号码券`
                  : '领奖回执 · 暂无已开奖待领票据'}
              </strong>
              <button
                type="button"
                className="lottery-icon-btn"
                aria-label="关闭领奖回执"
                onClick={() => setLastClaim(null)}
              >
                <X size={15} aria-hidden="true" />
              </button>
            </div>
            {(lastClaim.tickets ?? []).length > 0 && (
              <ul className="lottery-claim-list">
                {(lastClaim.tickets ?? []).map((ticket) => (
                  <li key={ticket.id}>
                    <span>
                      {poolName(ticket.tier)} · {formatUTC(ticket.batch_id)} · 命中 {ticket.hits} 球
                    </span>
                    <strong>
                      {(ticket.prizes ?? []).length > 0
                        ? (ticket.prizes ?? []).map(prizeName).join(' · ')
                        : '无额外派奖'}
                    </strong>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {status && (
          <div className="lottery-records">
            <section className="lottery-record-section" aria-labelledby="my-tickets-heading">
              <div className="lottery-record-head">
                <h3 id="my-tickets-heading">我的号码券 ({tickets.length})</h3>
                {claimableCount > 0 && (
                  <span className="lottery-claimable-hint">其中 {claimableCount} 张可领奖</span>
                )}
              </div>
              {tickets.length === 0 ? (
                <p className="empty-state">暂无待开奖或待领取的号码券。</p>
              ) : (
                <ul className="lottery-ticket-grid">
                  {tickets.map((ticket) => (
                    <TicketCard
                      key={ticket.id}
                      ticket={ticket}
                      pool={poolById.get(ticket.tier)}
                      draw={drawByKey.get(`${ticket.batch_id}:${ticket.tier}`)}
                      currentBatch={batch}
                    />
                  ))}
                </ul>
              )}
            </section>

            <section className="lottery-record-section" aria-labelledby="draw-history-heading">
              <div className="lottery-record-head">
                <h3 id="draw-history-heading">近期开奖记录</h3>
                <span className="lottery-record-note">保留最近 7 轮开奖与 SHA-256 种子哈希</span>
              </div>
              {recentDraws.length === 0 ? (
                <p className="empty-state">暂无开奖记录。</p>
              ) : (
                <div className="lottery-table-wrap">
                  <table className="lottery-draws-table">
                    <thead>
                      <tr>
                        <th scope="col">批次 (UTC)</th>
                        <th scope="col">奖池</th>
                        <th scope="col">中奖号码</th>
                        <th scope="col">开奖种子哈希 (draw_seed_hash)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentDraws.map((draw) => {
                        const rowKey = `${draw.batch_id}-${draw.pool_id}`
                        const seedHash = draw.draw_seed_hash ?? ''
                        const expanded = Boolean(expandedHashes[rowKey])
                        const copied = copiedHashKey === rowKey
                        const shortHash =
                          seedHash.length > 20
                            ? `${seedHash.slice(0, 12)}…${seedHash.slice(-6)}`
                            : seedHash || '—'
                        return (
                          <tr key={rowKey}>
                            <td className="lottery-draw-time">
                              <time dateTime={draw.batch_id}>{formatUTC(draw.batch_id)}</time>
                              <small>开奖于 {formatUTC(draw.drawn_at)}</small>
                            </td>
                            <td>
                              <span className={`lottery-pool-tag lottery-pool-tag-${draw.pool_id}`}>
                                {poolName(draw.pool_id)}
                              </span>
                            </td>
                            <td>
                              <NumberBalls numbers={draw.winning_numbers ?? []} />
                            </td>
                            <td className="lottery-hash-cell">
                              <div className="lottery-hash-bar">
                                <code className="lottery-hash-short" title={seedHash}>
                                  {shortHash}
                                </code>
                                {seedHash && (
                                  <div className="lottery-hash-actions">
                                    <button
                                      type="button"
                                      className="lottery-hash-btn"
                                      aria-expanded={expanded}
                                      onClick={() =>
                                        setExpandedHashes((current) => ({
                                          ...current,
                                          [rowKey]: !current[rowKey],
                                        }))
                                      }
                                    >
                                      {expanded ? (
                                        <>
                                          <EyeOff size={13} aria-hidden="true" /> 收起
                                        </>
                                      ) : (
                                        <>
                                          <Eye size={13} aria-hidden="true" /> 展开
                                        </>
                                      )}
                                    </button>
                                    <button
                                      type="button"
                                      className={`lottery-hash-btn${copied ? ' is-copied' : ''}`}
                                      onClick={() => void handleCopyHash(rowKey, seedHash)}
                                    >
                                      {copied ? (
                                        <>
                                          <Check size={13} aria-hidden="true" /> 已复制
                                        </>
                                      ) : (
                                        <>
                                          <Copy size={13} aria-hidden="true" /> 复制
                                        </>
                                      )}
                                    </button>
                                  </div>
                                )}
                              </div>
                              {expanded && seedHash && (
                                <code className="lottery-hash-full">{seedHash}</code>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )}
      </section>

      <section className="panel hall-panel" aria-labelledby="scratch-heading">
        <div className="hall-section-title">
          <div>
            <h2 id="scratch-heading">刮刮乐</h2>
            <p>刮开金属涂层，按相同符号凑齐成组领取金币与材料奖励。</p>
          </div>
          <span className="hall-balance">
            <Coins size={16} aria-hidden="true" /> 可用金币{' '}
            <strong>{numberFormat.format(walletCoins)}</strong>
          </span>
        </div>

        <div className="scratch-shop">
          {SCRATCH_TYPES.map((type) => {
            const affordableCount = Math.floor(Math.max(0, walletCoins) / type.cost)
            const deficit = Math.max(0, type.cost - Math.max(0, walletCoins))
            const isSuper = type.id === 'scratch-super'
            return (
              <article
                key={type.id}
                className={`scratch-shop-card ${isSuper ? 'scratch-shop-super' : 'scratch-shop-tide'}`}
              >
                <div className="scratch-shop-info">
                  <div className="hall-card-title">
                    <Gem size={20} aria-hidden="true" />
                    <div>
                      <h3>{type.name}</h3>
                      <p>{type.tagline}</p>
                    </div>
                  </div>
                  <p
                    className={`scratch-shop-affordability${
                      affordableCount > 0 ? ' is-affordable' : ' is-short'
                    }`}
                  >
                    {affordableCount > 0
                      ? `可购 ${numberFormat.format(affordableCount)} 张`
                      : `金币不足（差 ${numberFormat.format(deficit)}）`}
                  </p>
                </div>
                <button
                  type="button"
                  className="button button-quiet"
                  disabled={pending}
                  aria-label={`花 ${type.cost} 金币购买${type.name}`}
                  onClick={() =>
                    void perform(
                      `buy-${type.id}`,
                      async (key) => {
                        const result = await sessionApi.buyScratch(type.id, key)
                        onScratchCardUpdate(result.card, result.player)
                        return `已购买${type.name}（#${result.card.id}）。`
                      },
                      { refreshOnError: false },
                    )
                  }
                >
                  <Coins size={16} aria-hidden="true" /> {type.cost} 金币购买
                </button>
              </article>
            )
          })}
        </div>

        <div className="scratch-collection-head">
          <h3 className="scratch-collection-title">我的刮刮乐</h3>
          <div className="scratch-filters" role="group" aria-label="筛选刮刮卡">
            <button
              type="button"
              className={`scratch-filter-btn${cardFilter === 'all' ? ' is-active' : ''}`}
              onClick={() => setCardFilter('all')}
            >
              全部 ({safeCards.length})
            </button>
            <button
              type="button"
              className={`scratch-filter-btn${cardFilter === 'unrevealed' ? ' is-active' : ''}`}
              onClick={() => setCardFilter('unrevealed')}
            >
              未刮开 ({unrevealedCount})
            </button>
            <button
              type="button"
              className={`scratch-filter-btn${cardFilter === 'revealed' ? ' is-active' : ''}`}
              onClick={() => setCardFilter('revealed')}
            >
              已刮开 ({revealedCount})
            </button>
          </div>
        </div>

        {safeCards.length === 0 ? (
          <p className="empty-state">暂无刮刮卡，可在上方选购一张试试手气。</p>
        ) : filteredCards.length === 0 ? (
          <p className="empty-state">当前筛选条件下暂无刮刮卡。</p>
        ) : (
          <div className="scratch-collection">
            {filteredCards.map((card) => (
              <ScratchCard
                key={card.id}
                card={card}
                pending={pending}
                revealing={activeAction === `reveal-${card.id}`}
                onReveal={() =>
                  perform(
                    `reveal-${card.id}`,
                    async (key) => {
                      const result = await sessionApi.revealScratch(card.id, key)
                      onScratchCardUpdate(result.card, result.player)
                      return `已刮开第 ${card.id} 号刮刮卡。`
                    },
                    { refreshOnError: false, revealCardId: card.id },
                  )
                }
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
