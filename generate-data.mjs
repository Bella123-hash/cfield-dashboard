#!/usr/bin/env node
import { createHmac, randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const BASE = process.env.CFIELD_API_BASE || 'https://api-field.creeklabs.io/cfield/api/v1';
const FP = 'dashboard-' + randomBytes(6).toString('hex');
const DATA_FILE = new URL('./data.json', import.meta.url).pathname;
const SNAPSHOT_FILE = new URL('./rankings-snapshot.json', import.meta.url).pathname;

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

// ── STEP 1: Get secret ──
const secretRes = await fetch(BASE + '/guest/secret?device_fingerprint=' + FP);
const secretData = await secretRes.json();
if (secretData.code !== 200) { console.error('Secret failed'); process.exit(1); }
const secret = secretData.data.secret;

// ── STEP 2: Fetch all data ──
const [teamsRes, equityRes, ordersRes] = await Promise.all([
  guestGet(secret, '/guest/competition/teams', 'competition_id=1'),
  guestGet(secret, '/guest/competition/portfolio/by-team', 'competition_id=1'),
  guestGet(secret, '/guest/trade-order', 'limit=80&offset=0&sort=DESC'),
]);

const teams = teamsRes.code === 200 ? teamsRes.data.teams : [];
const equityTeams = equityRes.code === 200 ? equityRes.data.teams : [];
const orders = ordersRes.code === 200 ? ordersRes.data.orders || [] : [];

// Build team name map
const nameMap = {};
for (const t of teams) { nameMap[t.id] = t.name; nameMap['team_0' + t.id] = t.name; nameMap['team_' + t.id] = t.name; }

// ── Rankings by equity curve ──
const rankings = equityTeams.map(t => {
  const eq = t.equity_history?.equity || [];
  const latest = eq.length > 0 ? eq[eq.length - 1] : 0;
  const first = eq.length > 0 ? eq[0] : 100000;
  const pnl = latest - first;
  const pnlPct = first > 0 ? (pnl / first * 100) : 0;
  return { id: String(t.team_id), name: t.team_name, equity: latest, pnl, pnlPct };
}).sort((a, b) => b.pnl - a.pnl);

// ── Fetch positions for top 15 ──
// Load previous rankings snapshot
let prevRankings = [];
try {
  if (existsSync(SNAPSHOT_FILE)) {
    const prevData = JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8'));
    prevRankings = prevData.rankings || [];
  }
} catch (e) { /* first run */ }

const prevRankMap = {};
prevRankings.forEach((t, i) => { prevRankMap[t.id] = i + 1; });

const topWithPositions = [];
for (const t of rankings.slice(0, 15)) {
  let positions = [];
  for (const fmt of [t.id, 'team_0' + t.id, 'team_' + t.id]) {
    const r = await guestGet(secret, '/guest/position-snapshot', `team_id=${fmt}`);
    if (r.code === 200 && r.data?.positions) { positions = r.data.positions; break; }
  }
  topWithPositions.push({ ...t, positions });
}

// Calculate rank changes and detect anomalies
const rankingsWithChanges = topWithPositions.map((t, i) => {
  const currentRank = i + 1;
  const prevRank = prevRankMap[t.id] || null;
  const rankChange = prevRank !== null ? prevRank - currentRank : null;
  const isAnomaly = rankChange !== null && Math.abs(rankChange) > 5;
  return { ...t, currentRank, prevRank, rankChange, isAnomaly };
});

const anomalies = rankingsWithChanges.filter(t => t.isAnomaly);

// Save current rankings snapshot
writeFileSync(SNAPSHOT_FILE, JSON.stringify({
  date: new Date().toISOString(),
  rankings: rankings.map((t, i) => ({ id: t.id, name: t.name, rank: i + 1 })),
}, null, 2));

// ── Order analysis ──
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
      id: tid,
      name: nameMap[tid] || tid,
      total: ords.length,
      buys: buys.length,
      sells: sells.length,
      filled: filled.length,
      canceled: canceled.length,
      symbols,
      recent: ords.slice(0, 3).map(o => ({
        time: o.submitted_at,
        side: o.side,
        symbol: o.symbol,
        qty: o.qty,
        type: o.type,
        status: o.status,
        filled_qty: o.filled_qty,
      })),
    };
  });

const buyCount = orders.filter(o => o.side === 'buy').length;
const sellCount = orders.filter(o => o.side === 'sell').length;
const topSymbols = Object.entries(symbolsMap).sort((a, b) => b[1] - a[1]).slice(0, 10);
const buyRatio = orders.length > 0 ? buyCount / orders.length : 0;
const limitCount = orders.filter(o => o.type === 'limit').length;
const marketCount = orders.filter(o => o.type === 'market').length;

// ── Anomaly analysis ──
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
  name: t.name,
  id: t.id,
  currentRank: t.currentRank,
  prevRank: t.prevRank,
  rankChange: t.rankChange,
  reasons: analyzeAnomaly(t, activeTeams),
  positions: t.positions.map(p => ({
    symbol: p.symbol,
    unrealizedPl: p.unrealized_pl,
  })),
}));

// ── Auto-commentary ──
const commentaries = [];
const allSellTeams = activeTeams.filter(t => t.buys === 0 && t.sells > 0).map(t => t.name);
const allBuyTeams = activeTeams.filter(t => t.sells === 0 && t.buys > 0).map(t => t.name);
const zeroTradeTeams = rankings.filter(r => !activeTeams.find(t => t.id === r.id || 'team_0' + t.id === r.id || 'team_' + t.id === r.id)).slice(0, 5);

if (buyRatio < 0.3) commentaries.push('今日市场情绪极度偏空，全部为卖出操作，各队伍一致获利了结。');
else if (buyRatio > 0.7) commentaries.push('今日市场情绪积极做多，买入订单占主导。');
else commentaries.push('今日买卖力量相对均衡。');

if (limitCount > orders.length * 0.7) commentaries.push('限价单占比极高，说明各队不急于市价成交，在等待更好的价格。');

const highCancelTeams = activeTeams.filter(t => t.canceled > t.total * 0.5 && t.total >= 5);
if (highCancelTeams.length > 0) commentaries.push(`${highCancelTeams.map(t => t.name).join('、')} 撤单率异常高，可能存在策略测试或风控频繁触发。`);

const onlyFilledTeams = activeTeams.filter(t => t.filled > 0 && t.canceled === 0);
if (onlyFilledTeams.length > 0) commentaries.push(`${onlyFilledTeams.map(t => t.name).join('、')} 成交干净利落，操作最为稳健。`);

const leader = rankings[0];
const runnerUp = rankings[1];
if (leader && runnerUp) {
  const gap = leader.pnl - runnerUp.pnl;
  if (gap > 5000) commentaries.push(`${leader.name} 以绝对优势领跑，与第二名差距 $${gap.toFixed(0)}，短期内难以被超越。`);
}

// ── Build output ──
const data = {
  generatedAt: new Date().toISOString(),
  competition: {
    name: 'AI Sandbox Challenge Round2',
    status: 'live',
    startTime: '2026-07-25T16:00:00.000Z',
    endTime: '2026-08-28T16:00:00.000Z',
    totalTeams: teams.length,
    activeTeams: activeTeams.length,
  },
  marketSummary: {
    indices: [
      { name: '道琼斯', change: '-2.18%', note: '收 51,594' },
      { name: '标普500', change: '-1.51%', note: '收 7,316' },
      { name: '纳斯达克', change: '-1.80%', note: '收 24,443' },
    ],
    highlights: [
      '科技股全面重挫，芯片板块领跌（美光 -9.45%，NVDA -3.47%）',
      '微软盘后财报超预期暴涨 +9%（Azure +43%，缩减资本开支）',
      'Meta 盘后暴跌 -7.4%（Q3指引低于预期，AI开支扩大）',
      '美联储维持利率不变，内部加息分歧加大',
      '30年期美债收益率飙破 5.2%，创 2007 年以来新高',
      '资金从 AI 硬件/芯片向企业软件/防御板块轮动',
    ],
    note: '市场数据需手动更新，可通过编辑 data.json 的 marketSummary 字段更新',
  },
  rankings: rankingsWithChanges.map((t, i) => ({
    rank: i + 1,
    name: t.name,
    id: t.id,
    pnl: t.pnl,
    pnlPct: t.pnlPct,
    equity: t.equity,
    prevRank: t.prevRank,
    rankChange: t.rankChange,
    isAnomaly: t.isAnomaly,
    positionCount: t.positions.length,
    positions: t.positions.map(p => ({
      symbol: p.symbol,
      name: p.name,
      qty: p.qty,
      marketValue: p.market_value,
      unrealizedPl: p.unrealized_pl,
      unrealizedPlpc: p.unrealized_plpc,
      side: p.side,
    })),
  })),
  tradingActivity: {
    totalOrders: orders.length,
    buyCount,
    sellCount,
    buyRatio,
    limitCount,
    marketCount,
    topSymbols: topSymbols.map(([s, c]) => ({ symbol: s, count: c })),
    statusBreakdown: statusMap,
    activeTeams,
  },
  commentary: {
    auto: commentaries,
  },
  anomalies: anomalyDetails,
};

writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
console.log('✅ 数据已生成: ' + DATA_FILE);
console.log(`   排名队伍: ${rankings.length} | 活跃队伍: ${activeTeams.length} | 订单: ${orders.length} | 排名异常: ${anomalies.length}`);
