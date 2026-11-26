import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Anchor,
  ArrowUpRight,
  Coins,
  Filter,
  Fish,
  Gem,
  Lock,
  PackageOpen,
  RotateCcw,
  Sparkles,
  Ticket,
} from 'lucide-react';
import { sessionApi } from '../api/client';
import {
  AFFIX_META,
  MATERIAL_LIST,
  MATERIAL_META,
  ROD_NAMES,
  SPECIES_NAMES,
  TIER_LABELS,
  TRAIT_LABELS,
  formatAffixValue,
} from '../api/presentation';
import type {
  AffixType,
  FXQuote,
  GuildInventoryResponse,
  GuildSellResponse,
} from '../api/types';
import './economy.css';

export interface GuildPanelProps {
  inventory: GuildInventoryResponse | null;
  quotes: FXQuote[];
  onSold: (res: GuildSellResponse) => void;
  onSelectFxSymbol?: (symbol: string) => void;
}

type TierFilter = 'all' | 'normal' | 'rare' | 'epic' | 'legendary';
type SortKey = 'default' | 'total' | 'unit' | 'weight' | 'tier';

const TIER_ORDER: readonly TierFilter[] = ['all', 'normal', 'rare', 'epic', 'legendary'];
const TIER_RANK: Readonly<Record<string, number>> = {
  normal: 1,
  rare: 2,
  epic: 3,
  legendary: 4,
};
const MATERIAL_ORDER = new Map(MATERIAL_LIST.map((item, idx) => [item.id, idx]));
const MATERIAL_TIER_LABELS: Readonly<Record<string, string>> = {
  common: '常规',
  rare: '稀有',
  epic: '史诗',
  legendary: '传说',
};

const countFmt = new Intl.NumberFormat('zh-CN');
const kilosFmt = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 });
const priceFmt = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signedFmt = new Intl.NumberFormat('zh-CN', { signDisplay: 'exceptZero', maximumFractionDigits: 2 });
const pctFmt = new Intl.NumberFormat('zh-CN', {
  style: 'percent',
  maximumFractionDigits: 2,
  signDisplay: 'exceptZero',
});

function weightLabel(grams: number): string {
  return grams >= 1_000 ? `${kilosFmt.format(grams / 1_000)} kg` : `${countFmt.format(grams)} g`;
}

export function GuildPanel({ inventory, quotes: fxQuotes, onSold, onSelectFxSymbol }: GuildPanelProps) {
  const [selection, setSelection] = useState<Set<number>>(() => new Set());
  const [tierFilter, setTierFilter] = useState<TierFilter>('all');
  const [traitFilter, setTraitFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<SortKey>('default');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<GuildSellResponse | null>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);

  const fish = useMemo(() => inventory?.fish ?? [], [inventory?.fish]);
  const rods = inventory?.rods ?? [];
  const guildQuotes = useMemo(() => inventory?.guild_quotes ?? [], [inventory?.guild_quotes]);

  const quoteByFishId = useMemo(
    () => new Map(guildQuotes.map((quote) => [quote.id, quote])),
    [guildQuotes],
  );
  const fxQuoteBySymbol = useMemo(
    () => new Map(fxQuotes.map((quote) => [quote.symbol, quote])),
    [fxQuotes],
  );

  // Prune stale fish IDs whenever inventory.fish updates (after sale, SSE, or refresh).
  useEffect(() => {
    const validIds = new Set(fish.map((item) => item.id));
    setSelection((current) => {
      let changed = false;
      for (const id of current) {
        if (!validIds.has(id)) {
          changed = true;
          break;
        }
      }
      if (!changed) return current;
      const next = new Set<number>();
      for (const id of current) {
        if (validIds.has(id)) next.add(id);
      }
      return next;
    });
  }, [fish]);

  const tierCounts = useMemo(() => {
    const counts: Record<string, number> = { all: fish.length };
    for (const item of fish) {
      counts[item.tier] = (counts[item.tier] ?? 0) + 1;
    }
    return counts;
  }, [fish]);

  const visibleFish = useMemo(() => {
    const filtered = fish.filter((item) => {
      if (tierFilter !== 'all' && item.tier !== tierFilter) return false;
      if (traitFilter !== 'all') {
        const traits = item.traits ?? [];
        if (!traits.includes(traitFilter)) return false;
      }
      return true;
    });

    if (sortBy === 'default') return filtered;

    return [...filtered].sort((a, b) => {
      const qa = quoteByFishId.get(a.id);
      const qb = quoteByFishId.get(b.id);
      if (sortBy === 'total') {
        return (qb?.total_price ?? 0) - (qa?.total_price ?? 0) || b.id - a.id;
      }
      if (sortBy === 'unit') {
        return (qb?.unit_price ?? 0) - (qa?.unit_price ?? 0) || b.id - a.id;
      }
      if (sortBy === 'weight') {
        return b.weight_g - a.weight_g || b.id - a.id;
      }
      if (sortBy === 'tier') {
        return (TIER_RANK[b.tier] ?? 0) - (TIER_RANK[a.tier] ?? 0) || (qb?.total_price ?? 0) - (qa?.total_price ?? 0);
      }
      return 0;
    });
  }, [fish, quoteByFishId, sortBy, tierFilter, traitFilter]);

  const visibleIds = useMemo(() => visibleFish.map((item) => item.id), [visibleFish]);
  const selectedFish = useMemo(() => fish.filter((item) => selection.has(item.id)), [fish, selection]);
  const selectedIds = useMemo(() => selectedFish.map((item) => item.id), [selectedFish]);
  const selectedUnitCount = useMemo(
    () => selectedFish.reduce((sum, item) => sum + item.quantity, 0),
    [selectedFish],
  );
  const selectedTotal = useMemo(
    () => selectedIds.reduce((sum, id) => sum + (quoteByFishId.get(id)?.total_price ?? 0), 0),
    [quoteByFishId, selectedIds],
  );

  const selectedVisibleCount = useMemo(
    () => visibleIds.filter((id) => selection.has(id)).length,
    [selection, visibleIds],
  );
  const allVisibleSelected = visibleFish.length > 0 && selectedVisibleCount === visibleFish.length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someVisibleSelected;
    }
  }, [someVisibleSelected]);

  const totalFishCount = useMemo(() => fish.reduce((sum, item) => sum + item.quantity, 0), [fish]);
  const warehouseTotalCoins = useMemo(
    () => fish.reduce((sum, item) => sum + (quoteByFishId.get(item.id)?.total_price ?? 0), 0),
    [fish, quoteByFishId],
  );

  const materials = useMemo(() => {
    const entries = Object.entries(inventory?.materials ?? {}).filter(([, qty]) => qty > 0);
    return entries.sort(([aId], [bId]) => {
      const aOrder = MATERIAL_ORDER.get(aId);
      const bOrder = MATERIAL_ORDER.get(bId);
      if (aOrder !== undefined && bOrder !== undefined) return aOrder - bOrder;
      if (aOrder !== undefined) return -1;
      if (bOrder !== undefined) return 1;
      return aId.localeCompare(bId, 'zh-CN');
    });
  }, [inventory?.materials]);

  const flows = receipt?.fx_flows ?? [];
  const hasActiveFilters = tierFilter !== 'all' || traitFilter !== 'all';

  function toggleRow(id: number) {
    setSelection((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible(checked: boolean) {
    setSelection((current) => {
      const next = new Set(current);
      if (checked) {
        for (const id of visibleIds) next.add(id);
      } else {
        for (const id of visibleIds) next.delete(id);
      }
      return next;
    });
  }

  function resetFilters() {
    setTierFilter('all');
    setTraitFilter('all');
    setSortBy('default');
  }

  async function sell(all: boolean) {
    if (pending || (all ? fish.length === 0 : selectedIds.length === 0)) return;
    setPending(true);
    setError('');
    setReceipt(null);
    try {
      const result = await sessionApi.guildSell(all ? { sell_all: true } : { fish_ids: selectedIds });
      onSold(result);
      setReceipt(result);
      setSelection(new Set());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '出售失败，请重试。');
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="economy-stack" aria-label="潮汐公会">
      <header className="economy-heading">
        <div>
          <p className="eyebrow">Tidal Guild</p>
          <h1>潮汐公会</h1>
        </div>
        {inventory && (
          <div className="economy-heading-badges">
            <span className="economy-meta">
              <Ticket size={17} aria-hidden="true" /> {countFmt.format(inventory.blank_tickets)} 空白票
            </span>
            <span className="economy-meta economy-meta--accent">
              <Coins size={16} aria-hidden="true" /> 估价 {countFmt.format(warehouseTotalCoins)} 金币
            </span>
          </div>
        )}
      </header>

      <div className="panel economy-surface">
        <header className="economy-panel-heading">
          <h2><Fish size={19} aria-hidden="true" /> 渔获仓库</h2>
          <span className="economy-muted">
            {countFmt.format(fish.length)} 堆 · {countFmt.format(totalFishCount)} 尾
          </span>
        </header>

        {fish.length > 0 && (
          <div className="guild-toolbar" role="region" aria-label="渔获筛选与排序">
            <div className="guild-filter-group" role="group" aria-label="按品质筛选">
              {TIER_ORDER.map((tier) => {
                const label = tier === 'all' ? '全部' : (TIER_LABELS[tier] ?? tier);
                const qty = tierCounts[tier] ?? 0;
                return (
                  <button
                    key={tier}
                    type="button"
                    className="guild-filter-pill"
                    aria-pressed={tierFilter === tier}
                    onClick={() => setTierFilter(tier)}
                  >
                    <span>{label}</span>
                    <small>{countFmt.format(qty)}</small>
                  </button>
                );
              })}
            </div>

            <div className="guild-toolbar-selects">
              <label className="guild-select-wrap">
                <Filter size={14} aria-hidden="true" />
                <span className="guild-select-label">词条</span>
                <select
                  aria-label="按词条筛选"
                  value={traitFilter}
                  onChange={(event) => setTraitFilter(event.target.value)}
                >
                  <option value="all">全部词条</option>
                  {Object.entries(TRAIT_LABELS).map(([id, label]) => (
                    <option key={id} value={id}>{label}</option>
                  ))}
                </select>
              </label>

              <label className="guild-select-wrap">
                <span className="guild-select-label">排序</span>
                <select
                  aria-label="渔获排序"
                  value={sortBy}
                  onChange={(event) => setSortBy(event.target.value as SortKey)}
                >
                  <option value="default">默认 (最新)</option>
                  <option value="total">总报价</option>
                  <option value="unit">单价</option>
                  <option value="weight">重量</option>
                  <option value="tier">品质</option>
                </select>
              </label>
            </div>
          </div>
        )}

        {!inventory ? (
          <div className="economy-empty" role="status">
            <PackageOpen size={28} aria-hidden="true" />
            <p>正在读取公会仓库…</p>
          </div>
        ) : fish.length === 0 ? (
          <div className="economy-empty">
            <PackageOpen size={28} aria-hidden="true" />
            <p>仓库里还没有渔获。</p>
          </div>
        ) : visibleFish.length === 0 ? (
          <div className="economy-empty">
            <Filter size={26} aria-hidden="true" />
            <p>当前筛选条件下没有匹配的渔获。</p>
            {hasActiveFilters && (
              <button type="button" className="button button-quiet" onClick={resetFilters}>
                <RotateCcw size={14} aria-hidden="true" /> 重置筛选
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="economy-table-wrap" role="region" aria-label="渔获及公会报价" tabIndex={0}>
              <table className="economy-table guild-table">
                <thead>
                  <tr>
                    <th scope="col">
                      <input
                        ref={selectAllRef}
                        type="checkbox"
                        aria-label="选择当前可见渔获"
                        checked={allVisibleSelected}
                        disabled={pending}
                        onChange={(event) => toggleAllVisible(event.target.checked)}
                      />
                    </th>
                    <th scope="col">鱼种 &amp; 品质</th>
                    <th scope="col">词条</th>
                    <th scope="col">单尾重量</th>
                    <th scope="col">数量</th>
                    <th scope="col">公会报价</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleFish.map((item) => {
                    const name = SPECIES_NAMES[item.item_id] ?? item.item_id;
                    const quote = quoteByFishId.get(item.id);
                    const traits = item.traits ?? [];

                    return (
                      <tr key={item.id} className={selection.has(item.id) ? 'is-selected' : undefined}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`选择 ${name} #${item.id}`}
                            checked={selection.has(item.id)}
                            disabled={pending}
                            onChange={() => toggleRow(item.id)}
                          />
                        </td>
                        <th scope="row">
                          <strong>{name}</strong>
                          <span className={`economy-tag guild-tier guild-tier--${item.tier}`}>
                            {TIER_LABELS[item.tier] ?? item.tier}
                          </span>
                        </th>
                        <td>
                          <div className="economy-tags">
                            {traits.length > 0 ? (
                              traits.map((trait) => {
                                const fxQuote = fxQuoteBySymbol.get(trait);
                                const activeMove = fxQuote && (fxQuote.change !== 0 || fxQuote.today_volume > 0);
                                return (
                                  <span
                                    key={trait}
                                    className={`economy-tag${activeMove ? ' guild-trait-active' : ''}`}
                                    title={
                                      fxQuote
                                        ? `${TRAIT_LABELS[trait] ?? trait} · FX 中间价 ${priceFmt.format(fxQuote.mid)} (${pctFmt.format(fxQuote.change)})`
                                        : undefined
                                    }
                                  >
                                    {TRAIT_LABELS[trait] ?? trait}
                                    {activeMove && fxQuote && (
                                      <small className={fxQuote.change > 0 ? 'fx-positive' : fxQuote.change < 0 ? 'fx-negative' : 'economy-muted'}>
                                        {fxQuote.change > 0 ? '↑' : fxQuote.change < 0 ? '↓' : '·'}
                                      </small>
                                    )}
                                  </span>
                                );
                              })
                            ) : (
                              <span className="economy-muted">无词条</span>
                            )}
                          </div>
                        </td>
                        <td>{weightLabel(item.weight_g)}</td>
                        <td>{countFmt.format(item.quantity)}</td>
                        <td>
                          {quote ? (
                            <div className="guild-quote">
                              <strong>{countFmt.format(quote.total_price)} 金币</strong>
                              <small>{countFmt.format(quote.unit_price)} / 尾</small>
                            </div>
                          ) : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <footer className="economy-panel-footer">
              <div className="guild-selection-summary">
                <span className="economy-muted">
                  已选 {countFmt.format(selectedIds.length)} 堆 · {countFmt.format(selectedUnitCount)} 尾 · 预计 {countFmt.format(selectedTotal)} 金币
                </span>
                {selectedIds.length > selectedVisibleCount && (
                  <small className="guild-hidden-selection">
                    （含当前筛选外 {countFmt.format(selectedIds.length - selectedVisibleCount)} 堆）
                  </small>
                )}
              </div>
              <div className="economy-actions">
                <button
                  className="button"
                  type="button"
                  onClick={() => void sell(false)}
                  disabled={pending || selectedIds.length === 0}
                >
                  {pending ? '处理中…' : '出售所选'}
                </button>
                <button
                  className="button button-primary"
                  type="button"
                  onClick={() => void sell(true)}
                  disabled={pending || fish.length === 0}
                >
                  {pending ? '交易处理中…' : '全部出售'}
                </button>
              </div>
            </footer>
          </>
        )}

        {error && <p className="economy-message economy-message--error" role="alert">{error}</p>}

        {receipt && (
          <div className="economy-message guild-receipt" role="status">
            <div className="economy-actions">
              <strong>已出售 {countFmt.format(receipt.sold_count)} 尾</strong>
              <span><Coins size={16} aria-hidden="true" /> +{countFmt.format(receipt.coins_earned)} 金币</span>
              <span><Ticket size={16} aria-hidden="true" /> +{countFmt.format(receipt.tickets_earned)} 空白票</span>
            </div>
            {flows.length > 0 && (
              <div className="guild-flow-row">
                <span className="economy-muted">FX 供给冲击（点击跳转交易所）</span>
                <div className="economy-tags">
                  {flows.map(({ symbol, net, volume }) => {
                    const liveQuote = fxQuoteBySymbol.get(symbol);
                    return (
                      <button
                        key={symbol}
                        type="button"
                        className="guild-flow-chip"
                        disabled={!onSelectFxSymbol}
                        onClick={() => onSelectFxSymbol?.(symbol)}
                      >
                        <strong>{TRAIT_LABELS[symbol] ?? symbol}</strong>
                        <span className={net < 0 ? 'fx-negative' : net > 0 ? 'fx-positive' : 'economy-muted'}>
                          净流 {signedFmt.format(net)}
                        </span>
                        <small>量 {countFmt.format(volume)}</small>
                        {liveQuote && <small>现价 {priceFmt.format(liveQuote.mid)}</small>}
                        <span className="guild-flow-cta">
                          前往 FX <ArrowUpRight size={13} aria-hidden="true" />
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="guild-supplies">
        <section className="panel economy-surface">
          <header className="economy-panel-heading">
            <h2><Gem size={19} aria-hidden="true" /> 材料</h2>
            <span className="economy-muted">{countFmt.format(materials.length)} 类</span>
          </header>
          <div className="guild-supply-list">
            {materials.length > 0 ? (
              materials.map(([materialId, quantity]) => {
                const meta = MATERIAL_META[materialId];
                const tier = meta?.tier ?? 'common';
                return (
                  <div className="guild-material-card" key={materialId}>
                    <div className="guild-supply-row">
                      <div className="economy-tags">
                        <strong>{meta?.name ?? materialId}</strong>
                        <span className={`economy-tag guild-material-tier guild-material-tier--${tier}`}>
                          {MATERIAL_TIER_LABELS[tier] ?? tier}
                        </span>
                      </div>
                      <strong className="guild-material-qty">× {countFmt.format(quantity)}</strong>
                    </div>
                    {meta?.description && (
                      <p className="guild-material-desc">{meta.description}</p>
                    )}
                  </div>
                );
              })
            ) : (
              <p className="economy-muted">{inventory ? '暂无材料' : '正在读取…'}</p>
            )}
          </div>
        </section>

        <section className="panel economy-surface">
          <header className="economy-panel-heading">
            <h2><Anchor size={19} aria-hidden="true" /> 鱼竿</h2>
            <span className="economy-muted">{countFmt.format(rods.length)} 支</span>
          </header>
          <div className="guild-supply-list">
            {rods.length > 0 ? (
              rods.map((rod) => {
                const affixes = rod.affixes ?? [];
                const rodName = ROD_NAMES[rod.template_id] ?? rod.template_id;
                const ratio = rod.max_durability > 0
                  ? Math.min(100, Math.max(0, Math.round((rod.durability / rod.max_durability) * 100)))
                  : 0;

                return (
                  <div className="guild-rod" key={rod.id}>
                    <div className="guild-supply-row">
                      <div className="economy-tags">
                        <strong>{rodName}</strong>
                        {rod.enhance_level > 0 && <span className="economy-tag guild-rod-enhance">+{rod.enhance_level}</span>}
                        {rod.equipped && <span className="economy-tag guild-rod-equipped">装备中</span>}
                        {rod.locked && <span className="economy-tag"><Lock size={12} aria-hidden="true" /> 已锁定</span>}
                      </div>
                      <span className="economy-muted guild-durability-text">
                        {countFmt.format(rod.durability)} / {countFmt.format(rod.max_durability)} ({ratio}%)
                      </span>
                    </div>
                    <progress
                      className={ratio <= 20 ? 'is-low' : undefined}
                      value={rod.durability}
                      max={Math.max(1, rod.max_durability)}
                      aria-label={`${rodName} 耐久度`}
                    />
                    {affixes.length > 0 && (
                      <div className="guild-affix-list" aria-label={`${rodName} 词条属性`}>
                        {affixes.map((affix, index) => {
                          const meta = AFFIX_META[affix.type as AffixType];
                          return (
                            <span
                              key={`${affix.type}-${index}`}
                              className="guild-affix-chip"
                              title={meta?.description}
                            >
                              <Sparkles size={12} aria-hidden="true" />
                              <span>{meta?.label ?? affix.type}</span>
                              <b>{formatAffixValue(affix.type, affix.value)}</b>
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })
            ) : (
              <p className="economy-muted">{inventory ? '暂无鱼竿' : '正在读取…'}</p>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}
