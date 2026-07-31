#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = new URL('.', import.meta.url).pathname;
const SNAPSHOT_FILE = __dirname + 'rankings-snapshot.json';

const BASE = process.env.CFIELD_API_BASE || 'https://api-field.creeklabs.io/cfield/api/v1';
const FP = 'dashboard-' + randomBytes(6).toString('hex');

function guestHeaders({ method, path, secret, fp, query = '', body = null }) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(16).toString('hex');
  const sortedQuery = query
    ? [...new URLSearchParams(query)].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => k + '=' + v).join('&')
    : '';
  const sortedBody = body && Object.keys(body).length
    ? JSON.stringify(Object.fromEntries(Object.keys(body).sort().map(k => [k, body[k]])))
    : '';
  const signString = [method.toUpperCase(), path, sortedQuery, sortedBody, ts, nonce].join('\n');
  const signature = createHmac('sha256', secret).update(signString).digest('hex');
  return { 'x-device-fingerprint': fp, 'x-guest-timestamp': ts, 'x-guest-nonce': nonce, 'x-guest-signature': signature };
}

async function guestGet(secret, path, query = '') {
  const fullPath = '/cfield/api/v1' + path;
  const hdrs = guestHeaders({ method: 'GET', path: fullPath, secret, fp: FP, query });
  const url = BASE + path + (query ? '?' + query : '');
  const res = await fetch(url, { headers: { ...hdrs, 'Accept': 'application/json' } });
  return res.json();
}

// ── Fetch data (same as generate-data.mjs) ──
console.log('>>> 获取 C-Field 数据...');
const secretRes = await fetch(BASE + '/guest/secret?device_fingerprint=' + FP);
const secretData = await secretRes.json();
if (secretData.code !== 200) { console.error('Secret failed'); process.exit(1); }
const secret = secretData.data.secret;

const [teamsRes, equityRes, ordersRes] = await Promise.all([
  guestGet(secret, '/guest/competition/teams', 'competition_id=1'),
  guestGet(secret, '/guest/competition/portfolio/by-team', 'competition_id=1'),
  guestGet(secret, '/guest/trade-order', 'limit=80&offset=0&sort=DESC'),
]);

const teams = teamsRes.code === 200 ? teamsRes.data.teams : [];
const equityTeams = equityRes.code === 200 ? equityRes.data.teams : [];
const orders = ordersRes.code === 200 ? ordersRes.data.orders || [] : [];

const nameMap = {};
for (const t of teams) { nameMap[t.id] = t.name; nameMap['team_0' + t.id] = t.name; nameMap['team_' + t.id] = t.name; }

const rankings = equityTeams.map(t => {
  const eq = t.equity_history?.equity || [];
  const latest = eq.length > 0 ? eq[eq.length - 1] : 0;
  const first = eq.length > 0 ? eq[0] : 100000;
  const pnl = latest - first;
  const pnlPct = first > 0 ? (pnl / first * 100) : 0;
  return { id: String(t.team_id), name: t.team_name, equity: latest, pnl, pnlPct };
}).sort((a, b) => b.pnl - a.pnl);

// Load previous rankings snapshot
let prevRankings = [];
try {
  if (existsSync(SNAPSHOT_FILE)) {
    const prevData = JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8'));
    prevRankings = prevData.rankings || [];
    console.log('   加载历史排名: ' + prevData.date);
  }
} catch (e) { console.log('   (首次运行，无历史排名数据)'); }

const prevRankMap = {};
prevRankings.forEach((t, i) => { prevRankMap[t.id] = i + 1; });

// Fetch positions for top 15
const topWithPositions = [];
for (const t of rankings.slice(0, 15)) {
  let positions = [];
  for (const fmt of [t.id, 'team_0' + t.id, 'team_' + t.id]) {
    const r = await guestGet(secret, '/guest/position-snapshot', `team_id=${fmt}`);
    if (r.code === 200 && r.data?.positions) { positions = r.data.positions; break; }
  }
  topWithPositions.push({ ...t, positions });
}

// Calculate rank changes and detect anomalies (analysis deferred until order data is ready)
const rankingsWithChanges = topWithPositions.map((t, i) => {
  const currentRank = i + 1;
  const prevRank = prevRankMap[t.id] || null;
  const rankChange = prevRank !== null ? prevRank - currentRank : null; // positive = up
  const isAnomaly = rankChange !== null && Math.abs(rankChange) > 5;
  return { ...t, currentRank, prevRank, rankChange, isAnomaly };
});

const anomalies = rankingsWithChanges.filter(t => t.isAnomaly);

// Save current rankings snapshot for next comparison
writeFileSync(SNAPSHOT_FILE, JSON.stringify({
  date: new Date().toISOString(),
  rankings: rankings.map((t, i) => ({ id: t.id, name: t.name, rank: i + 1 })),
}, null, 2));

const teamOrders = {};
const symbolsMap = {};
const statusMap = {};
for (const o of orders) {
  const tid = o.team_id;
  if (!teamOrders[tid]) teamOrders[tid] = [];
  teamOrders[tid].push(o);
  symbolsMap[o.symbol] = (symbolsMap[o.symbol] || 0) + 1;
  statusMap[o.status] = (statusMap[o.status] || 0) + 1;
}

const activeTeams = Object.entries(teamOrders)
  .sort((a, b) => b[1].length - a[1].length)
  .map(([tid, ords]) => {
    const buys = ords.filter(o => o.side === 'buy');
    const sells = ords.filter(o => o.side === 'sell');
    const filled = ords.filter(o => o.status === 'filled' || o.status === 'partial_filled');
    const canceled = ords.filter(o => o.status === 'canceled');
    const symbols = [...new Set(ords.map(o => o.symbol))];
    return {
      id: tid, name: nameMap[tid] || tid, total: ords.length,
      buys: buys.length, sells: sells.length, filled: filled.length, canceled: canceled.length, symbols,
      recent: ords.slice(0, 3).map(o => ({
        time: o.submitted_at, side: o.side, symbol: o.symbol, qty: o.qty,
        type: o.type, status: o.status, filled_qty: o.filled_qty,
      })),
    };
  });

const buyCount = orders.filter(o => o.side === 'buy').length;
const sellCount = orders.filter(o => o.side === 'sell').length;
const topSymbols = Object.entries(symbolsMap).sort((a, b) => b[1] - a[1]).slice(0, 10);
const buyRatio = orders.length > 0 ? buyCount / orders.length : 0;
const limitCount = orders.filter(o => o.type === 'limit').length;
const marketCount = orders.filter(o => o.type === 'market').length;

// ── Anomaly analysis (now that activeTeams is available) ──
function analyzeAnomaly(team, allActive) {
  const reasons = [];
  const activity = allActive.find(a => a.id === team.id || 'team_0' + a.id === team.id || 'team_' + a.id === team.id);
  if (team.rankChange > 0) {
    if (activity && activity.total > 0) {
      if (activity.buys > activity.sells) reasons.push('积极买入做多');
      if (activity.filled >= activity.total * 0.7) reasons.push('成交率高，策略执行果断');
      if (team.positions && team.positions.length > 0) {
        const winners = team.positions.filter(p => Number(p.unrealized_pl) > 0);
        if (winners.length > 0) reasons.push(`持仓${winners.map(p => p.symbol).join('、')}浮盈贡献`);
      }
    }
    if (reasons.length === 0) reasons.push('被动排名上升（其他队伍回撤）');
  } else {
    if (activity && activity.total > 0) {
      if (activity.sells > activity.buys) reasons.push('大量卖出/止损');
      if (activity.canceled > activity.total * 0.3) reasons.push('撤单率偏高，策略犹豫');
    }
    if (team.positions && team.positions.length > 0) {
      const losers = team.positions.filter(p => Number(p.unrealized_pl) < 0);
      if (losers.length > 0) reasons.push(`持仓${losers.map(p => p.symbol).join('、')}浮亏拖累`);
    }
    if (reasons.length === 0) reasons.push('持仓回调或空仓踏空');
  }
  return reasons;
}

const anomalyDetails = anomalies.map(t => ({
  ...t,
  reasons: analyzeAnomaly(t, activeTeams),
}));

const data = {
  generatedAt: new Date().toISOString(),
  json_rankings: rankingsWithChanges,
  json_allRankings: rankings,
  json_activeTeams: activeTeams,
  json_anomalies: anomalyDetails,
  json_orders: orders.length,
  json_buyCount: buyCount,
  json_sellCount: sellCount,
  json_buyRatio: buyRatio,
  json_limitCount: limitCount,
  json_marketCount: marketCount,
  json_topSymbols: topSymbols.map(([s, c]) => ({ symbol: s, count: c })),
  json_statusMap: statusMap,
};

// ── Read template and inject data ──
const template = readFileSync(new URL('./template.html', import.meta.url).pathname, 'utf8');
const html = template.replace('__DATA_PLACEHOLDER__', JSON.stringify(data));

const outPath = new URL('./index.html', import.meta.url).pathname;
writeFileSync(outPath, html);
console.log('✅ 仪表盘已生成: ' + outPath);
console.log(`   排名队伍: ${rankings.length} | 活跃: ${activeTeams.length} | 订单: ${orders.length} | 排名异常: ${anomalies.length}`);
