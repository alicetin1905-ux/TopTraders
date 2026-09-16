/** Display helpers shared by the dashboard. */

export function usd(v, { compact = false, sign = false } = {}) {
  if (v === null || v === undefined || !isFinite(v)) return '—';
  // Without this, zero picks the sub-$1 branch and prints "$0.0000".
  if (v === 0) return '$0';
  const abs = Math.abs(v);
  const s = v < 0 ? '-' : (sign && v > 0 ? '+' : '');
  if (compact) {
    if (abs >= 1e9) return `${s}$${(abs / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${s}$${(abs / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `${s}$${(abs / 1e3).toFixed(1)}K`;
  }
  const dp = abs >= 1000 ? 0 : abs >= 1 ? 2 : 4;
  return `${s}$${abs.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

export function price(v) {
  if (v === null || v === undefined || !isFinite(v) || v === 0) return '—';
  const abs = Math.abs(v);
  const dp = abs >= 1000 ? 2 : abs >= 1 ? 3 : abs >= 0.01 ? 5 : 8;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

export function qty(v) {
  if (v === null || v === undefined || !isFinite(v)) return '—';
  const abs = Math.abs(v);
  const dp = abs >= 1000 ? 1 : abs >= 1 ? 3 : 4;
  return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: dp });
}

export function pct(v, { sign = false } = {}) {
  if (v === null || v === undefined || !isFinite(v)) return '—';
  const s = sign && v > 0 ? '+' : '';
  return `${s}${(v * 100).toFixed(2)}%`;
}

export function shortAddr(a) {
  if (!a) return '—';
  if (!a.startsWith('0x')) return a.length > 18 ? `${a.slice(0, 16)}…` : a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function ago(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : 'flat');
