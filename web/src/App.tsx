import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { Anchor, ChartCandlestick, CircleAlert, Fish, Ticket, Warehouse } from 'lucide-react';
import { api, ApiError, errorMessage, onUnauthorized, setAuthToken } from './api/client';
import type { AuthResponse } from './api/types';
import { AuthGate } from './components/AuthGate';
import FishingDeck from './components/FishingDeck';
import { FxTerminal } from './components/FxTerminal';
import { GuildPanel } from './components/GuildPanel';
import { LotteryScratchHall } from './components/LotteryScratchHall';
import { MarketHeader } from './components/MarketHeader';
import { useMarketSync } from './state/useMarketSync';

const storageKey = 'deepmarket.session';
const tabs = [
  { id: 'fishing', name: 'Fishing Deck', label: '钓鱼甲板', icon: Fish },
  { id: 'guild', name: 'Tidal Guild', label: '潮汐公会', icon: Warehouse },
  { id: 'fx', name: 'DeepSea FX', label: '深海交易所', icon: ChartCandlestick },
  { id: 'lottery', name: 'Lottery & Scratch', label: '彩票与刮刮乐', icon: Ticket },
] as const;

function Market({ session, onSignOut }: { session: AuthResponse; onSignOut: () => void }) {
  const { token, user } = session;
  const [tab, setTab] = useState<(typeof tabs)[number]['id']>('fishing');
  const [selectedSymbol, setSelectedSymbol] = useState('swift');
  const [signingOut, setSigningOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');

  useLayoutEffect(() => {
    setAuthToken(token);
  }, [token]);

  const {
    wallet,
    fishing,
    inventory,
    quotes,
    candleRevision,
    lottery,
    cards,
    events,
    globalLegendary,
    lastCatchEvent,
    connection,
    lastEnvelope,
    syncError,
    refresh,
    acceptFishingCommand,
    acceptPlayer,
    acceptLotteryClaim,
    acceptLotteryCraft,
    acceptScratchCard,
  } = useMarketSync(session);

  async function logout() {
    setSigningOut(true);
    setLogoutError('');
    try {
      await api.logout(token);
      onSignOut();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return;
      setLogoutError(errorMessage(error));
      setSigningOut(false);
    }
  }

  const activeTab = tabs.find((item) => item.id === tab) ?? tabs[0];
  const ticketCount = inventory?.blank_tickets ?? lottery?.blank_tickets ?? wallet.blankTickets;

  return (
    <div className="market-shell">
      <MarketHeader
        wallet={wallet}
        ticketCount={ticketCount}
        connection={connection}
        lastEnvelope={lastEnvelope}
        user={user}
        signingOut={signingOut}
        onLogout={() => void logout()}
      />

      <div className="market-workspace">
        <nav className="market-nav" aria-label="鱼市导航">
          {tabs.map(({ id, name, label, icon: Icon }) => (
            <button
              type="button"
              key={id}
              onClick={() => setTab(id)}
              aria-current={id === tab ? 'page' : undefined}
            >
              <Icon size={19} aria-hidden="true" />
              <span>
                <strong>{label}</strong>
                <small>{name}</small>
              </span>
            </button>
          ))}
        </nav>

        <main className="market-content" aria-label={activeTab.label}>
          {(syncError || logoutError) && (
            <div className="market-notice" role="alert">
              <CircleAlert size={17} aria-hidden="true" />
              <span>{logoutError || `同步失败 · ${syncError}`}</span>
              {syncError && (
                <button
                  type="button"
                  className="button button-quiet"
                  onClick={() => void refresh()}
                >
                  重试同步
                </button>
              )}
            </div>
          )}

          {tab === 'fishing' && (
            <FishingDeck
              fishing={fishing}
              inventory={inventory}
              events={events}
              globalLegendary={globalLegendary}
              lastCatchEvent={lastCatchEvent}
              onFishingCommand={acceptFishingCommand}
              onPlayerUpdate={acceptPlayer}
            />
          )}

          {tab === 'guild' && (
            <GuildPanel
              inventory={inventory}
              quotes={quotes}
              onSold={(res) => {
                acceptPlayer(res.player);
                void refresh(['inventory', 'lottery', 'quotes']);
              }}
              onSelectFxSymbol={(symbol) => {
                setSelectedSymbol(symbol);
                setTab('fx');
              }}
            />
          )}

          {tab === 'fx' && (
            <FxTerminal
              quotes={quotes}
              inventory={inventory}
              walletCoins={wallet.coins}
              candleRevision={candleRevision}
              selectedSymbol={selectedSymbol}
              onSelectSymbol={setSelectedSymbol}
              onTradeSuccess={(player) => {
                acceptPlayer(player);
                void refresh(['inventory', 'quotes']);
              }}
            />
          )}

          {tab === 'lottery' && (
            <LotteryScratchHall
              lottery={lottery}
              cards={cards}
              walletCoins={wallet.coins}
              canDrawBatch={import.meta.env.DEV || user.role === 'admin'}
              onPlayerUpdate={(player) => {
                acceptPlayer(player);
                void refresh(['lottery', 'inventory', 'fishing']);
              }}
              onRefreshLottery={() => refresh(['lottery'])}
              onClaimed={acceptLotteryClaim}
              onCrafted={acceptLotteryCraft}
              onScratchCardUpdate={acceptScratchCard}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function savedToken() {
  try {
    return localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

export default function App() {
  const [token, setToken] = useState(savedToken);
  const [session, setSession] = useState<AuthResponse | null>(null);
  const [restoreError, setRestoreError] = useState('');
  const [restoreAttempt, setRestoreAttempt] = useState(0);

  useLayoutEffect(() => {
    setAuthToken(token);
  }, [token]);

  const signOut = useCallback(() => {
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* Session storage is optional. */
    }
    setAuthToken(null);
    setToken(null);
    setSession(null);
    setRestoreError('');
  }, []);

  function authenticated(next: AuthResponse) {
    try {
      localStorage.setItem(storageKey, next.token);
    } catch {
      /* The session stays in memory. */
    }
    setAuthToken(next.token);
    setSession(next);
    setToken(next.token);
  }

  useEffect(() => {
    if (!token) return;
    return onUnauthorized((rejected) => {
      if (rejected === token) signOut();
    });
  }, [signOut, token]);

  useEffect(() => {
    if (!token || session?.token === token) return;
    const controller = new AbortController();
    void api
      .me(token, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setSession({ ...data, token });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !(error instanceof ApiError && error.status === 401)) {
          setRestoreError(errorMessage(error));
        }
      });
    return () => controller.abort();
  }, [restoreAttempt, session?.token, token]);

  if (session && session.token === token) {
    return <Market key={token} session={session} onSignOut={signOut} />;
  }
  if (!token) {
    return <AuthGate onAuthenticated={authenticated} />;
  }

  return (
    <main className="session-loading">
      <div className="panel">
        <Anchor size={28} aria-hidden="true" />
        <h1>DeepMarket</h1>
        <p role={restoreError ? 'alert' : 'status'}>
          {restoreError || '正在恢复会话…'}
        </p>
        {restoreError && (
          <div className="session-actions">
            <button
              type="button"
              className="button button-primary"
              onClick={() => {
                setRestoreError('');
                setRestoreAttempt((attempt) => attempt + 1);
              }}
            >
              重试
            </button>
            <button type="button" className="button button-quiet" onClick={signOut}>
              返回登录
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
