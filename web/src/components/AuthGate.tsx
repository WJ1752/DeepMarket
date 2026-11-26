import {
  Anchor,
  ArrowRight,
  ChartCandlestick,
  Eye,
  EyeOff,
  LockKeyhole,
  Radio,
  ShieldCheck,
  UserRound,
  Waves,
} from 'lucide-react';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, errorMessage } from '../api/client';
import { DEPTH_LIST } from '../api/presentation';
import type { AuthResponse } from '../api/types';
import './auth.css';

interface AuthGateProps {
  onAuthenticated: (auth: AuthResponse) => void;
}

export function AuthGate({ onAuthenticated }: AuthGateProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const registering = mode === 'register';

  function switchMode(next: typeof mode) {
    if (next === mode) return;
    setMode(next);
    setPassword('');
    setShowPassword(false);
    setError('');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;

    const name = username.trim();
    const nameLength = Array.from(name).length;
    if (!name) {
      setError('请输入用户名。');
      return;
    }
    if (registering && (nameLength < 3 || nameLength > 32)) {
      setError('用户名须为 3 至 32 个字符。');
      return;
    }
    if (!password) {
      setError('请输入密码。');
      return;
    }
    if (registering && Array.from(password).length < 8) {
      setError('密码至少需要 8 个字符。');
      return;
    }

    submitting.current = true;
    setPending(true);
    setError('');
    try {
      const session = await (registering
        ? api.register(name, password)
        : api.login(name, password));
      onAuthenticated(session);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <main className="auth-gate">
      <div className="auth-portal-grid">
        <section className="auth-showcase" aria-label="深海鱼市概览">
          <div className="auth-showcase-head">
            <p className="eyebrow">MARITIME TERMINAL · DEEP MARKET</p>
            <h2>深海垂钓、词条外汇与潮汐奖厅</h2>
            <p className="auth-showcase-lead">
              从近岸浅滩到 2.96× 极端高压海渊，实时推送每次咬钩与脱钩记录，将渔获交予潮汐公会并驱动 8 大词条市场行情。
            </p>
          </div>

          <div className="auth-sonar-chart">
            <svg
              className="auth-sonar-svg"
              viewBox="0 0 120 120"
              role="img"
              aria-label="声呐测深仪示意图"
            >
              <circle cx="60" cy="60" r="52" fill="#071218" stroke="#213a45" strokeWidth="1.5" />
              <circle cx="60" cy="60" r="36" fill="none" stroke="#1d3d4a" strokeDasharray="3 3" />
              <circle cx="60" cy="60" r="20" fill="none" stroke="#254c5a" />
              <line x1="8" y1="60" x2="112" y2="60" stroke="#1a343f" strokeWidth="1" />
              <line x1="60" y1="8" x2="60" y2="112" stroke="#1a343f" strokeWidth="1" />
              <path d="M60 60 L96 28 A52 52 0 0 1 108 60 Z" fill="rgba(98, 220, 193, 0.16)" />
              <line x1="60" y1="60" x2="96" y2="28" stroke="#62dcc1" strokeWidth="1.5" />
              <circle cx="83" cy="44" r="3" fill="#62dcc1" />
              <circle cx="38" cy="76" r="2.5" fill="#70cce1" />
              <circle cx="60" cy="60" r="3.5" fill="#efcb80" />
            </svg>

            <ul className="auth-depth-list" aria-label="六大海域水压层级">
              {DEPTH_LIST.map((depth) => (
                <li key={depth.id}>
                  <strong>{depth.name}</strong>
                  <span>{depth.pressure.toFixed(2)}×</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="auth-capabilities" aria-label="系统特性">
            <span className="auth-cap-chip">
              <Waves size={14} aria-hidden="true" />
              六大海域实时垂钓
            </span>
            <span className="auth-cap-chip">
              <ChartCandlestick size={14} aria-hidden="true" />
              8 词条 K 线交易所
            </span>
            <span className="auth-cap-chip">
              <Radio size={14} aria-hidden="true" />
              SSE 实时推送
            </span>
            <span className="auth-cap-chip">
              <ShieldCheck size={14} aria-hidden="true" />
              HMAC-SHA256 签名信封
            </span>
          </div>
        </section>

        <section className="auth-card panel" aria-labelledby="auth-title">
          <div className="auth-brand">
            <span className="auth-emblem">
              <Anchor size={24} aria-hidden="true" />
            </span>
            <div>
              <p className="eyebrow">深海鱼市</p>
              <h1 id="auth-title">DeepMarket</h1>
            </div>
          </div>

          <div className="auth-modes" role="group" aria-label="账号操作">
            <button
              type="button"
              aria-pressed={!registering}
              disabled={pending}
              onClick={() => switchMode('login')}
            >
              登录
            </button>
            <button
              type="button"
              aria-pressed={registering}
              disabled={pending}
              onClick={() => switchMode('register')}
            >
              注册
            </button>
          </div>

          <form className="auth-form" onSubmit={submit} aria-busy={pending} noValidate>
            <label className="auth-field" htmlFor="auth-username">
              <span>
                <UserRound size={15} aria-hidden="true" /> 用户名
              </span>
              <input
                id="auth-username"
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="输入渔夫代号"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                disabled={pending}
                required
              />
            </label>

            <label className="auth-field" htmlFor="auth-password">
              <span>
                <LockKeyhole size={15} aria-hidden="true" /> 密码
              </span>
              <div className="auth-password-wrap">
                <input
                  id="auth-password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete={registering ? 'new-password' : 'current-password'}
                  aria-describedby={registering ? 'auth-password-rule' : undefined}
                  placeholder={registering ? '至少 8 个字符' : '输入账号密码'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={pending}
                  required
                />
                <button
                  type="button"
                  className="auth-eye-toggle"
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                  aria-pressed={showPassword}
                  disabled={pending}
                  onClick={() => setShowPassword((visible) => !visible)}
                >
                  {showPassword ? (
                    <EyeOff size={16} aria-hidden="true" />
                  ) : (
                    <Eye size={16} aria-hidden="true" />
                  )}
                </button>
              </div>
            </label>

            {registering && (
              <p className="auth-rule" id="auth-password-rule">
                用户名 3–32 个字符，密码至少 8 个字符。
              </p>
            )}
            {error && (
              <p className="inline-error" role="alert">
                {error}
              </p>
            )}
            <button type="submit" className="button button-primary auth-submit" disabled={pending}>
              <span>{pending ? '连接中…' : registering ? '创建账号' : '进入鱼市'}</span>
              <ArrowRight size={17} aria-hidden="true" />
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
