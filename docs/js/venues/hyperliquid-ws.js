/**
 * Live fill stream for Hyperliquid.
 *
 * The snapshot pipeline can only see net change between ticks, and GitHub
 * throttles the schedule to roughly hourly -- so a trader who opens and closes
 * inside one interval is currently invisible. This subscribes to userFills over
 * the websocket instead, which reports actual executions: price, size, and
 * realized PnL per fill, as they happen.
 *
 * Hyperliquid caps a socket at 15 tracked users ("Cannot track more than 15
 * total users"), so addresses are spread over a small pool of sockets.
 */

const WS_URL = 'wss://api.hyperliquid.xyz/ws';
const USERS_PER_SOCKET = 15;
const SUBSCRIBE_STAGGER_MS = 60;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;

const num = (v) => (v === undefined || v === null || v === '' ? 0 : parseFloat(v));

/**
 * @param {object} opts
 * @param {string[]} opts.addresses  traders to follow, most important first
 * @param {(fills: object[]) => void} opts.onFills  called with normalized fills
 * @param {(status: object) => void} [opts.onStatus]
 * @returns {{ stop: () => void }}
 */
export function createFillStream({ addresses, onFills, onStatus = () => {} }) {
  const groups = [];
  for (let i = 0; i < addresses.length; i += USERS_PER_SOCKET) {
    groups.push(addresses.slice(i, i + USERS_PER_SOCKET));
  }

  // Fills repeat in the snapshot batch after every reconnect; tid is the
  // exchange's own trade id, so it is the natural dedupe key.
  const seen = new Set();
  let stopped = false;
  let connected = 0;
  const sockets = [];

  const status = () => onStatus({ sockets: sockets.length, connected, tracking: addresses.length });

  function connect(group, index, attempt = 0) {
    if (stopped) return;
    let ws;
    try {
      ws = new WebSocket(WS_URL);
    } catch {
      return retry(group, index, attempt);
    }
    sockets[index] = ws;

    ws.onopen = () => {
      if (stopped) { ws.close(); return; }
      connected++;
      status();
      group.forEach((user, i) => setTimeout(() => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'userFills', user } }));
        }
      }, i * SUBSCRIBE_STAGGER_MS));
    };

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.channel !== 'userFills') return;

      const address = msg.data?.user;
      const isSnapshot = !!msg.data?.isSnapshot;
      const out = [];
      for (const f of msg.data?.fills || []) {
        // "@151" and friends are spot indices; this dashboard tracks perps.
        if (!f.coin || f.coin.startsWith('@')) continue;
        const key = f.tid ?? `${f.hash}:${f.oid}:${f.time}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const size = num(f.sz);
        const price = num(f.px);
        out.push({
          key,
          ts: Number(f.time) || Date.now(),
          address,
          coin: f.coin,
          dir: f.dir || (f.side === 'B' ? 'Buy' : 'Sell'),
          size,
          price,
          value: size * price,
          closedPnl: num(f.closedPnl),
          fee: num(f.fee),
          isSnapshot,
        });
      }
      if (out.length) onFills(out);
    };

    ws.onclose = () => {
      if (!stopped) { connected = Math.max(0, connected - 1); status(); retry(group, index, attempt + 1); }
    };
    ws.onerror = () => { try { ws.close(); } catch { /* onclose handles retry */ } };
  }

  function retry(group, index, attempt) {
    if (stopped) return;
    const wait = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
    setTimeout(() => connect(group, index, attempt), wait);
  }

  groups.forEach((g, i) => connect(g, i));

  return {
    stop() {
      stopped = true;
      for (const ws of sockets) { try { ws.close(); } catch { /* already gone */ } }
      connected = 0;
    },
  };
}

export const MAX_TRACKED_PER_SOCKET = USERS_PER_SOCKET;
