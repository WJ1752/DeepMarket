import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  BarChart3,
  Coins,
  Layers,
  Wallet,
} from 'lucide-react';
import { sessionApi } from '../api/client';
import type {
  FXCandlesResponse,
  FXGrain,
  FXQuote,
  FXSide,
  FXTradeResponse,
  GuildInventoryResponse,
  PublicPlayer,
} from '../api/types';
import { FxCandleChart } from './FxCandleChart';
import './economy.css';

export interface FxTerminalProps {
  quotes: FXQuote[];
  inventory: GuildInventoryResponse | null;
  walletCoins: number;
  candleRevision: number;
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
  onTradeSuccess: (player: PublicPlayer) => void;
}

const MAX_POSITION = 200;
const GRAINS: readonly FXGrain[] = [15, 30, 60, 120];
const QUANTITIES: readonly number[] = [1, 5, 10, 25];

const countFmt = new Intl.NumberFormat('zh-CN');
const priceFmt = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pctFmt = new Intl.NumberFormat('zh-CN', {
  style: 'percent',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: 'exceptZero',
});
const signedFmt = new Intl.NumberFormat('zh-CN', { signDisplay: 'exceptZero', maximumFractionDigits: 2 });

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function FxTerminal({
  quotes,
  inventory,
  walletCoins,
  candleRevision,
  selectedSymbol,
  onSelectSymbol,
  onTradeSuccess,
}: FxTerminalProps) {
  const [grain, setGrain] = useState<FXGrain>(60);
  const [watchlistFilter, setWatchlistFilter] = useState<'all' | 'held'>('all');
  const [series, setSeries] = useState<FXCandlesResponse | null>(null);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartError, setChartError] = useState<{ symbol: string; grain: FXGrain; message: string } | null>(null);

  const [side, setSide] = useState<FXSide>('buy');
  const [quantity, setQuantity] = useState('1');
  const [pending, setPending] = useState(false);
  const [tradeError, setTradeError] = useState('');
  const [receipt, setReceipt] = useState<FXTradeResponse | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setChartLoading(true);

    sessionApi
      .fxCandles(selectedSymbol, grain, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setSeries(result);
        setChartError(null);
        setChartLoading(false);
      })
      .catch((failure: unknown) => {
        if (
          controller.signal.aborted ||
          (failure instanceof DOMException && failure.name === 'AbortError')
        ) {
          return;
        }
        setChartError({
          symbol: selectedSymbol,
          grain,
          message: failure instanceof Error ? failure.message : '读取 K 线失败。',
        });
        setChartLoading(false);
      });

    return () => controller.abort();
  }, [selectedSymbol, grain, candleRevision]);

  const quote = useMemo(
    () => quotes.find((item) => item.symbol === selectedSymbol),
    [quotes, selectedSymbol],
  );
  const fallbackPos = inventory?.positions?.[selectedSymbol];
  const currentPosition = quote?.position ?? fallbackPos?.quantity ?? 0;
  const currentAvgCost = quote?.avg_cost ?? fallbackPos?.avg_cost ?? 0;

  const overview = useMemo(() => {
    const hasQuotes = quotes.length > 0;
    const positionValue = hasQuotes
      ? quotes.reduce((sum, item) => sum + item.position * item.mid, 0)
      : Object.values(inventory?.positions ?? {}).reduce(
          (sum, pos) => sum + pos.quantity * pos.avg_cost,
          0,
        );
    const heldCount = hasQuotes
      ? quotes.filter((item) => item.position > 0).length
      : Object.values(inventory?.positions ?? {}).filter((pos) => pos.quantity > 0).length;
    const totalVolume = quotes.reduce((sum, item) => sum + item.today_volume, 0);
    const advancingCount = quotes.filter((item) => item.change > 0).length;

    return {
      positionValue,
      heldCount,
      totalVolume,
      advancingCount,
      hasQuotes,
    };
  }, [inventory?.positions, quotes]);

  const visibleQuotes = useMemo(() => {
    if (watchlistFilter === 'held') {
      return quotes.filter((item) => item.position > 0);
    }
    return quotes;
  }, [quotes, watchlistFilter]);

  const candles = series?.symbol === selectedSymbol && series.grain === grain ? series.candles : [];
  const chartFailure =
    chartError?.symbol === selectedSymbol && chartError.grain === grain ? chartError.message : '';

  const units = Number(quantity);
  const unitPrice = quote?.[side] ?? 0;
  const gross = unitPrice * units;
  const validQuantity = Number.isSafeInteger(units) && units > 0 && Number.isSafeInteger(gross);
  const fee = validQuantity ? Math.ceil(gross * 0.02) : 0;
  const total = side === 'buy' ? gross + fee : Math.max(0, gross - fee);
  const canSubmit = Boolean(quote && validQuantity && Number.isSafeInteger(total));

  const remainingCap = Math.max(0, MAX_POSITION - currentPosition);
  const maxBuyAffordable = useMemo(() => {
    if (!quote || quote.buy <= 0 || remainingCap <= 0 || walletCoins <= 0) return 0;
    let maxUnits = Math.min(remainingCap, Math.floor(walletCoins / (quote.buy * 1.02)));
    while (
      maxUnits < remainingCap &&
      (maxUnits + 1) * quote.buy + Math.ceil((maxUnits + 1) * quote.buy * 0.02) <= walletCoins
    ) {
      maxUnits += 1;
    }
    while (
      maxUnits > 0 &&
      maxUnits * quote.buy + Math.ceil(maxUnits * quote.buy * 0.02) > walletCoins
    ) {
      maxUnits -= 1;
    }
    return maxUnits;
  }, [quote, remainingCap, walletCoins]);

  const maxPresetValue = side === 'buy' ? maxBuyAffordable : currentPosition;

  const orderHints = useMemo(() => {
    const hints: string[] = [];
    if (!quote || !validQuantity) return hints;
    if (side === 'buy') {
      if (units > remainingCap) {
        hints.push(`买入后将超过 ${MAX_POSITION} 份持仓上限（当前最多可买 ${countFmt.format(remainingCap)} 份）。`);
      }
      if (total > walletCoins) {
        hints.push(`预估支出 ${countFmt.format(total)} 金币，超出可用余额（${countFmt.format(walletCoins)} 金币）。`);
      }
    } else if (units > currentPosition) {
      hints.push(`卖出数量超出当前持仓（最多可卖 ${countFmt.format(currentPosition)} 份）。`);
    }
    return hints;
  }, [currentPosition, quote, remainingCap, side, total, units, validQuantity, walletCoins]);

  async function execute(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !canSubmit) return;
    setPending(true);
    setTradeError('');
    setReceipt(null);
    try {
      const res = await sessionApi.tradeFX(side, selectedSymbol, units);
      onTradeSuccess(res.player);
      setReceipt(res);
    } catch (failure) {
      setTradeError(failure instanceof Error ? failure.message : '交易失败，请重试。');
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="economy-stack" aria-label="深海外汇">
      <header className="economy-heading">
        <div>
          <p className="eyebrow">DeepSea FX</p>
          <h1>深海外汇</h1>
        </div>
      </header>

      <div className="fx-kpi-strip" role="region" aria-label="交易账户概览">
        <div className="panel fx-kpi-card">
          <span className="fx-kpi-label"><Wallet size={15} aria-hidden="true" /> 可用金币</span>
          <strong className="fx-kpi-value">{countFmt.format(walletCoins)}</strong>
          <small className="economy-muted">用于买入与支付 2% 手续费</small>
        </div>
        <div className="panel fx-kpi-card">
          <span className="fx-kpi-label"><Layers size={15} aria-hidden="true" /> 持仓估值</span>
          <strong className="fx-kpi-value">
            {overview.hasQuotes ? priceFmt.format(overview.positionValue) : countFmt.format(Math.round(overview.positionValue))}
          </strong>
          <small className="economy-muted">
            {overview.heldCount > 0 ? `持有 ${countFmt.format(overview.heldCount)} 个词条` : '暂无词条持仓'}
          </small>
        </div>
        <div className="panel fx-kpi-card">
          <span className="fx-kpi-label"><BarChart3 size={15} aria-hidden="true" /> 今日总成交 / 上涨</span>
          <strong className="fx-kpi-value">{countFmt.format(overview.totalVolume)}</strong>
          <small className="economy-muted">
            {overview.hasQuotes
              ? `${countFmt.format(overview.advancingCount)} / ${countFmt.format(quotes.length)} 标的上涨`
              : '等待实时行情'}
          </small>
        </div>
      </div>

      <section className="panel economy-surface">
        <header className="economy-panel-heading">
          <h2><Activity size={19} aria-hidden="true" /> 词条行情</h2>
          <div className="fx-options" role="group" aria-label="行情列表筛选">
            <button
              className="fx-option"
              type="button"
              aria-pressed={watchlistFilter === 'all'}
              onClick={() => setWatchlistFilter('all')}
            >
              全部 ({quotes.length})
            </button>
            <button
              className="fx-option"
              type="button"
              aria-pressed={watchlistFilter === 'held'}
              onClick={() => setWatchlistFilter('held')}
            >
              持仓中 ({overview.heldCount})
            </button>
          </div>
        </header>

        {quotes.length === 0 ? (
          <p className="economy-empty">正在读取词条行情…</p>
        ) : visibleQuotes.length === 0 ? (
          <div className="economy-empty">
            <p>当前没有持仓中的词条标的。</p>
            <button
              type="button"
              className="button button-quiet"
              onClick={() => setWatchlistFilter('all')}
            >
              查看全部标的
            </button>
          </div>
        ) : (
          <div className="economy-table-wrap" role="region" aria-label="词条行情及持仓" tabIndex={0}>
            <table className="economy-table fx-watchlist">
              <thead>
                <tr>
                  <th scope="col">标的</th>
                  <th scope="col">中间价</th>
                  <th scope="col">买入 / 卖出</th>
                  <th scope="col">日涨跌</th>
                  <th scope="col">净流 / 成交量</th>
                  <th scope="col">持仓 / 均价</th>
                </tr>
              </thead>
              <tbody>
                {visibleQuotes.map((item) => {
                  const imbalance = clamp(
                    item.today_volume > 0 ? item.imbalance : 0,
                    -1,
                    1,
                  );
                  const unrealizedPnl = item.position > 0 ? (item.sell - item.avg_cost) * item.position : 0;

                  return (
                    <tr
                      key={item.symbol}
                      className={item.symbol === selectedSymbol ? 'is-selected' : undefined}
                    >
                      <th scope="row">
                        <button
                          className="fx-symbol"
                          type="button"
                          aria-pressed={item.symbol === selectedSymbol}
                          disabled={pending}
                          onClick={() => {
                            onSelectSymbol(item.symbol);
                            setTradeError('');
                          }}
                        >
                          <strong>{item.label}</strong>
                          <small>{item.symbol}</small>
                        </button>
                      </th>
                      <td><strong>{priceFmt.format(item.mid)}</strong></td>
                      <td>{countFmt.format(item.buy)} / {countFmt.format(item.sell)}</td>
                      <td className={item.change < 0 ? 'fx-negative' : item.change > 0 ? 'fx-positive' : 'economy-muted'}>
                        {pctFmt.format(item.change)}
                      </td>
                      <td>
                        <div className="fx-imbalance">
                          <div className="fx-imbalance-track" aria-hidden="true">
                            <span
                              style={{
                                left: `${50 + Math.min(0, imbalance) * 50}%`,
                                width: `${Math.abs(imbalance) * 50}%`,
                              }}
                              className={imbalance < 0 ? 'is-negative' : ''}
                            />
                          </div>
                          <small>
                            {signedFmt.format(item.today_net)} / {countFmt.format(item.today_volume)} · {pctFmt.format(imbalance)}
                          </small>
                        </div>
                      </td>
                      <td>
                        <div className="fx-pos-cell">
                          <span>{countFmt.format(item.position)} / {priceFmt.format(item.avg_cost)}</span>
                          {item.position > 0 && (
                            <small className={unrealizedPnl > 0 ? 'fx-positive' : unrealizedPnl < 0 ? 'fx-negative' : 'economy-muted'}>
                              浮盈 {signedFmt.format(unrealizedPnl)}
                            </small>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="fx-workspace">
        <section className="panel economy-surface fx-chart-panel">
          <header className="economy-panel-heading fx-chart-head">
            <div className="fx-chart-head-title">
              <h2>{quote?.label ?? selectedSymbol} <small className="fx-symbol-code">{selectedSymbol}</small></h2>
              {quote && (
                <div className="fx-chart-head-meta">
                  <span className="fx-chart-mid">{priceFmt.format(quote.mid)}</span>
                  <span className={quote.change > 0 ? 'fx-positive' : quote.change < 0 ? 'fx-negative' : 'economy-muted'}>
                    {pctFmt.format(quote.change)}
                  </span>
                  <small className="economy-muted">基准 {priceFmt.format(quote.base_price)}</small>
                </div>
              )}
            </div>
            <div className="fx-options" role="group" aria-label="K 线周期">
              {GRAINS.map((value) => (
                <button
                  className="fx-option"
                  type="button"
                  key={value}
                  aria-pressed={grain === value}
                  onClick={() => setGrain(value)}
                >
                  {value}m
                </button>
              ))}
            </div>
          </header>

          {chartFailure && <p className="economy-message economy-message--error" role="alert">{chartFailure}</p>}

          {(!chartFailure || candles.length > 0) && (
            <FxCandleChart
              candles={candles}
              symbol={selectedSymbol}
              grain={grain}
              label={quote?.label ?? selectedSymbol}
              quote={quote}
              loading={chartLoading}
            />
          )}
        </section>

        <form className="panel economy-surface fx-order" onSubmit={(event) => void execute(event)}>
          <header className="economy-panel-heading">
            <h2>交易 · {quote?.label ?? selectedSymbol}</h2>
            <span className="economy-muted">
              持仓 {countFmt.format(currentPosition)} / {MAX_POSITION}
            </span>
          </header>

          <div className="fx-order-body">
            <div className="fx-price-strip" aria-label="当前盘口报价">
              <div>
                <span>卖出价</span>
                <strong className="fx-negative">{quote ? countFmt.format(quote.sell) : '—'}</strong>
              </div>
              <div>
                <span>中间价</span>
                <strong>{quote ? priceFmt.format(quote.mid) : '—'}</strong>
              </div>
              <div>
                <span>买入价</span>
                <strong className="fx-positive">{quote ? countFmt.format(quote.buy) : '—'}</strong>
              </div>
            </div>

            <div className="fx-cap-bar" aria-label={`持仓上限 ${currentPosition} / ${MAX_POSITION}`}>
              <div className="fx-cap-meta">
                <span>持仓限额</span>
                <span>
                  剩余可买 {countFmt.format(remainingCap)} 份
                  {currentPosition > 0 && ` · 均价 ${priceFmt.format(currentAvgCost)}`}
                </span>
              </div>
              <progress value={currentPosition} max={MAX_POSITION} aria-label="当前持仓占比" />
            </div>

            <div className="fx-options fx-order-sides" role="group" aria-label="交易方向">
              <button
                className="fx-option"
                type="button"
                aria-pressed={side === 'buy'}
                disabled={pending}
                onClick={() => {
                  setSide('buy');
                  setTradeError('');
                }}
              >
                <ArrowUpRight size={17} aria-hidden="true" /> 买入
              </button>
              <button
                className="fx-option"
                type="button"
                aria-pressed={side === 'sell'}
                disabled={pending}
                onClick={() => {
                  setSide('sell');
                  setTradeError('');
                }}
              >
                <ArrowDownLeft size={17} aria-hidden="true" /> 卖出
              </button>
            </div>

            <label className="fx-quantity">
              <span>
                数量
                <small>
                  {side === 'buy' ? (
                    <><Coins size={12} aria-hidden="true" /> 可用 {countFmt.format(walletCoins)}</>
                  ) : (
                    <>可卖 {countFmt.format(currentPosition)} 份</>
                  )}
                </small>
              </span>
              <input
                type="number"
                min={1}
                step={1}
                value={quantity}
                inputMode="numeric"
                required
                disabled={pending}
                onChange={(event) => {
                  setQuantity(event.target.value);
                  setTradeError('');
                }}
              />
            </label>

            <div className="fx-options fx-order-presets" role="group" aria-label="数量预设">
              {QUANTITIES.map((preset) => (
                <button
                  className="fx-option"
                  type="button"
                  key={preset}
                  aria-pressed={units === preset}
                  disabled={pending}
                  onClick={() => {
                    setQuantity(String(preset));
                    setTradeError('');
                  }}
                >
                  {preset}
                </button>
              ))}
              <button
                className="fx-option"
                type="button"
                disabled={pending || maxPresetValue <= 0}
                onClick={() => {
                  if (maxPresetValue > 0) {
                    setQuantity(String(maxPresetValue));
                    setTradeError('');
                  }
                }}
                title={side === 'buy' ? '按当前余额与持仓上限填入最大可买数量' : '填入全部可卖持仓'}
              >
                最大 ({countFmt.format(maxPresetValue)})
              </button>
            </div>

            <dl className="fx-estimate">
              <div>
                <dt>参考单价</dt>
                <dd>{quote ? countFmt.format(unitPrice) : '—'}</dd>
              </div>
              <div>
                <dt>预估手续费 (2%, ceil)</dt>
                <dd>{validQuantity && quote ? countFmt.format(fee) : '—'}</dd>
              </div>
              <div>
                <dt>{side === 'buy' ? '预估支出' : '预估收入'}</dt>
                <dd>{validQuantity && quote ? `${countFmt.format(total)} 金币` : '—'}</dd>
              </div>
            </dl>

            {orderHints.length > 0 && (
              <div className="fx-order-hint" role="note">
                {orderHints.map((hint) => (
                  <p key={hint}>{hint}</p>
                ))}
              </div>
            )}

            <button
              className="button button-primary"
              type="submit"
              disabled={pending || !canSubmit}
            >
              {pending ? '交易处理中…' : side === 'buy' ? '确认买入' : '确认卖出'}
            </button>

            {tradeError && <p className="economy-message economy-message--error" role="alert">{tradeError}</p>}

            {receipt && (
              <div className="economy-message fx-receipt" role="status">
                <strong>
                  {receipt.side === 'buy' ? '买入' : '卖出'} {countFmt.format(receipt.quantity)} {receipt.symbol} · {countFmt.format(receipt.unit_price)} 金币 / 份
                </strong>
                <span>
                  手续费 {countFmt.format(receipt.fee)} · 持仓 {countFmt.format(receipt.new_position_qty)} · 均价 {priceFmt.format(receipt.new_avg_cost)}
                </span>
              </div>
            )}
          </div>
        </form>
      </div>
    </section>
  );
}
