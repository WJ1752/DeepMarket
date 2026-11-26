import { Anchor, Coins, Gem, LogOut, Radio, ShieldCheck, Ticket } from 'lucide-react';
import type { SSEConnection } from '../api/sse';
import type { MarketWallet, PublicUser, SSEEnvelope } from '../api/types';
import './auth.css';

export interface MarketHeaderProps {
  wallet: MarketWallet;
  ticketCount?: number;
  connection: SSEConnection;
  lastEnvelope: SSEEnvelope | null;
  user: PublicUser;
  signingOut: boolean;
  onLogout: () => void;
}

const connectionLabel: Record<SSEConnection, string> = {
  connected: '实时在线',
  connecting: '连接中',
  reconnecting: '重新连接',
  closed: '连接断开',
};

const numberFormat = new Intl.NumberFormat('zh-CN');

export function MarketHeader({
  wallet,
  ticketCount,
  connection,
  lastEnvelope,
  user,
  signingOut,
  onLogout,
}: MarketHeaderProps) {
  const playerSignature = lastEnvelope?.sig;

  return (
    <header className="market-header">
      <div className="market-header-inner">
        <div className="market-brand">
          <span className="brand-icon">
            <Anchor size={21} aria-hidden="true" />
          </span>
          <div>
            <strong>DeepMarket</strong>
            <span>深海鱼市</span>
          </div>
        </div>

        <div className="market-status" aria-label="账户状态">
          <span className="status-pill balance" title="可用金币">
            <Coins size={15} aria-hidden="true" />
            <strong>{numberFormat.format(wallet.coins)}</strong>
            <span>金币</span>
          </span>
          <span className="status-pill black-coins" title="深海黑币（只读储备）">
            <Gem size={14} aria-hidden="true" />
            <strong>{numberFormat.format(wallet.blackCoins)}</strong>
            <span>黑币</span>
          </span>
          <span className="status-pill" title="空白奖券数量">
            <Ticket size={15} aria-hidden="true" />
            <strong>
              {ticketCount === undefined ? '–' : numberFormat.format(ticketCount)}
            </strong>
            <span>空白券</span>
          </span>
          <span className="status-pill mono" title="库存修订号与玩家版本">
            inv_rev {wallet.invRev} / v{wallet.version}
          </span>
          <span
            className="status-pill sse-pill"
            data-connected={connection === 'connected'}
            data-state={connection}
            title="SSE 实时事件流"
          >
            <span className="sse-dot" aria-hidden="true" />
            <Radio size={14} aria-hidden="true" />
            <span>{connectionLabel[connection]}</span>
          </span>
          <span
            className="status-pill mono signature"
            title={
              playerSignature
                ? `HMAC-SHA256 服务端签名（格式已校验）· ${playerSignature}`
                : '等待服务端签名信封'
            }
          >
            <ShieldCheck size={15} aria-hidden="true" />
            <span>HMAC {playerSignature ? playerSignature.slice(0, 8) : '–'}</span>
          </span>
        </div>

        <div className="market-account">
          {user.role && user.role !== 'player' && (
            <span className="account-role-badge" title={`账号权限：${user.role}`}>
              {user.role}
            </span>
          )}
          <span className="account-username" title={user.username}>
            {user.username}
          </span>
          <button
            type="button"
            className="button button-quiet logout-button"
            onClick={onLogout}
            disabled={signingOut}
          >
            <LogOut size={16} aria-hidden="true" />
            <span>退出</span>
          </button>
        </div>
      </div>
    </header>
  );
}
