#!/usr/bin/env node
// TopCat Screener — procura tokens por FDV, volume, idade e distância ao ATH.
// EVM: subgraphs Uniswap V2/V3 na The Graph. Solana: GeckoTerminal (não há subgraph DEX fiável na The Graph).
// Sem dependências: Node 18+.  Uso: GRAPH_API_KEY=xxxx node server.js   →   http://localhost:3000

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const GATEWAY = process.env.GRAPH_GATEWAY || 'https://gateway.thegraph.com/api';
const GT_BASE = process.env.GT_BASE || 'https://api.geckoterminal.com/api/v2';
const DAY = 86400;

// Chave da The Graph: variável de ambiente GRAPH_API_KEY, config.json (fora do git) ou campo na interface.
// Não fica no código: no VPS vem de /etc/topcatscreener.env (criado pelo deploy-vps.sh).
let CONFIG_KEY = process.env.GRAPH_API_KEY || '';
let ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || '';
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  if (!CONFIG_KEY && cfg.GRAPH_API_KEY) CONFIG_KEY = cfg.GRAPH_API_KEY;
  if (!ACCESS_PASSWORD && cfg.ACCESS_PASSWORD) ACCESS_PASSWORD = cfg.ACCESS_PASSWORD;
} catch (_) {}

// Acesso externo: palavra-passe (HTTP Basic, qualquer utilizador) e no máximo 2 pesquisas em simultâneo.
const crypto = require('crypto');
const MAX_SCANS = Number(process.env.MAX_SCANS || 2);
let runningScans = 0;
function authorized(req) {
  if (!ACCESS_PASSWORD) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const pass = decoded.slice(decoded.indexOf(':') + 1);
  const a = crypto.createHash('sha256').update(pass).digest();
  const b = crypto.createHash('sha256').update(ACCESS_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// Subgraphs (verificados no registo graph-uniswap-mcp, ago/2026).
// As versões usadas (V2, V3, V4) escolhem-se nas Definições. Atenção: algumas pools V4 com hooks reportam volume inflacionado.
const CHAINS = {
  ethereum: { label: 'Ethereum', explorer: 'https://etherscan.io/token/', gtNet: 'eth', sources: [
    { name: 'Uniswap V3', id: '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV', ver: 'V3' },
    // V4: o subgraph oficial da Uniswap primeiro (out/2026: avariado nos indexadores); depois alternativas
    { name: 'Uniswap V4', id: 'DiYPVdygkfjDWhbxGSqAQxwBKmfKnkWQojqeM2rkLb3G', alt: ['6XvRX3WHSvzBVTiPdF66XSBVbxWuHqijWANbjJxRDyzr', '8B2wKxnkciCTc5HSgsAojF6vhKn6wxQ1nVecYzMge1hA'], ver: 'V4' },
    { name: 'Uniswap V2', id: 'GmSczqdCDZ3hJeYY9JphwsADn5rePUzUKm8EZcVuhRAm', alt: ['A3Np3RQbaBA6oKJgiwDJeo5T3zrYfGHPWFYayMwtNDum'], ver: 'V2' },
  ] },
  base: { label: 'Base', explorer: 'https://basescan.org/token/', gtNet: 'base', sources: [
    { name: 'Uniswap V3', id: '96eJ9Go8gFjySRGnndG7EYxThaiwVDV8BYPp1TMDcoYh', ver: 'V3' },
    { name: 'Uniswap V4', id: 'Gqm2b5J85n1bhCyDMpGbtbVn4935EvvdyHdHrx3dibyj', ver: 'V4' },
    { name: 'Uniswap V2', id: 'DbcUmZwXBYbNZvLuDEvcmFa4uAWwwjrdX8dVFg1AUVKa', ver: 'V2' },
  ] },
  bsc: { label: 'BSC', explorer: 'https://bscscan.com/token/', gtNet: 'bsc', sources: [
    { name: 'Uniswap V3', id: '7XgdLW3bts4HktCYsu9dy8bEnuiNeZuftcuK3Aj4JXYV', ver: 'V3' },
    { name: 'Uniswap V4', id: 'EAq1nJKgjnuKH6Gj4RFjCW7LcL7E2uipbncdwV7TTWkX', ver: 'V4' },
    // PancakeSwap V2 (a maior DEX da BSC): a PancakeSwap não publica o V2 na The Graph; este é de terceiros ("Pancakeswap V2").
    // PancakeSwap V3 fica de fora: out/2026 o oficial (Hv1Gnc…) dá indexing_error e o alternativo (78EUqz…) não tem dados diários.
    { name: 'PancakeSwap V2', id: 'Aj9TDh9SPcn7cz4DXW26ga22VnBzHhPVuKGmE4YBzDFj', ver: 'V2' },
  ] },
  arbitrum: { label: 'Arbitrum', explorer: 'https://arbiscan.io/token/', gtNet: 'arbitrum', sources: [
    { name: 'Uniswap V3', id: 'FbCGRftH4a3yZugY7TnbYgPJVEv2LvMT6oF1fxPe9aJM', ver: 'V3' },
    { name: 'Uniswap V4', id: 'D1VHPU6cXXSC8eaApWCjCnPcTZQFSYCpGoDAvt4ogDWh', ver: 'V4' },
  ] },
  polygon: { label: 'Polygon', explorer: 'https://polygonscan.com/token/', gtNet: 'polygon_pos', sources: [
    { name: 'Uniswap V3', id: 'EsLGwxyeMMeJuhqWvuLmJEiDKXJ4Z6YsoJreUnyeozco', ver: 'V3' },
    { name: 'Uniswap V4', id: '2CB2uQxcDKWDenagn2z17KQVCtfwSx5eXYuvqTciRTJu', ver: 'V4' },
  ] },
  optimism: { label: 'Optimism', explorer: 'https://optimistic.etherscan.io/token/', gtNet: 'optimism', sources: [
    { name: 'Uniswap V3', id: 'Cghf4LfVqPiFw6fp6Y5X5Ubc8UpmUhSfJL82zwiBFLaj', ver: 'V3' },
    { name: 'Uniswap V4', id: '3Tn7Y1NJAr4ySKm7KFu1dwvH2WM3mHJnXzXAxQsdBDvW', ver: 'V4' },
  ] },
  solana: { label: 'Solana', explorer: 'https://solscan.io/token/', gecko: 'solana' },
  // Chains novas sem subgraph DEX na The Graph: GeckoTerminal. O id de rede é descoberto na lista de redes do GeckoTerminal.
  robinhood: { label: 'Robinhood Chain', gecko: 'auto', match: /robinhood/i, fallback: 'robinhood-chain' },
  arc: { label: 'Arc', gecko: 'auto', match: /^arc(\s+(network|mainnet|chain))?$/i, fallback: 'arc' },
  // "Outras blockchains": moedas de gas das L1 (KAS, ICP, AVAX, ADA…) pelo CoinGecko; opcionalmente também os tokens
  // das DEX dessas redes pelo GeckoTerminal (Definições). Não é uma chain com subgraph nem com endereço de contrato.
  others: { label: 'Other blockchains', others: true },
};

// Resolve ids de rede do GeckoTerminal (uma vez, com cache).
const gtDexIds = new Map();
async function geckoDexId(net, re) {
  const ck = net + ':' + re.source; if (gtDexIds.has(ck)) return gtDexIds.get(ck);
  let hit = null;
  for (let page = 1; page <= 10 && !hit; page++) {
    let d; try { d = await gt(`/networks/${net}/dexes?page=${page}`); } catch (_) { break; }
    const list = d.data || [];
    hit = list.find((x) => re.test(String(x.attributes?.name || '')) || re.test(String(x.id || '').replace(/[-_]/g, ' ')));
    if (!list.length || !d.links?.next) break;
  }
  const id = hit ? String(hit.id) : null; gtDexIds.set(ck, id); return id;
}
// O GeckoTerminal grátis só dá os últimos ~6 meses de velas diárias (o resto é para planos pagos).
// Se o token é mais antigo do que o histórico recebido, o "ATH" é só o máximo desse período: fica marcado (athPartial).
function geckoPartial(list, created) {
  if (!list.length) return false;
  const first = Math.min(...list.map((x) => Number(x[0])));
  if (created) return created < first - 2 * DAY;
  return Date.now() / 1000 - first >= 170 * DAY;
}
const GT_DEX = { 'uniswap-v4': { re: /uniswap\s*v4/i, label: 'Uniswap V4' } };

let gtNetworks = null;
let gtNetworksAt = 0;
async function loadGtNetworks() {
  if (gtNetworks && gtNetworks.length && Date.now() - gtNetworksAt < 24 * 3600e3) return gtNetworks;
  const list = [];
  try {
    for (let page = 1; page <= 15; page++) {
      const d = await gt(`/networks?page=${page}`);
      const data = d.data || [];
      for (const n of data) if (n && n.id && (!n.type || n.type === 'network')) list.push({ id: String(n.id), name: String(n.attributes?.name || '') });
      if (!d.links?.next || !data.length) break;
    }
  } catch (_) { /* fica o que houver */ }
  if (list.length) { gtNetworks = list; gtNetworksAt = Date.now(); }
  return gtNetworks || [];
}
// "Outras blockchains": qualquer rede do GeckoTerminal (Avalanche, ICP, Kaspa, Sui, TON, …), com a chave "gt:<id da rede>".
// São criadas quando são pedidas e usam o GeckoTerminal para tudo (preço, volume, ATH, liquidez).
const OTHER_RE = /^gt:[a-z0-9][a-z0-9_-]{0,60}$/;
async function ensureChain(k) {
  if (CHAINS[k]) return true;
  if (!OTHER_RE.test(k)) return false;
  const id = k.slice(3);
  const n = (await loadGtNetworks()).find((x) => x.id === id);
  if (!n) return false;
  CHAINS[k] = { label: n.name || id, gecko: id, dynamic: true };
  return true;
}
// GoPlus também verifica algumas destas redes (EVM)
const GP_GT = { avax: '43114', ftm: '250', cro: '25', linea: '59144', zksync: '324', mantle: '5000', blast: '81457', scroll: '534352', opbnb: '204', 'polygon-zkevm': '1101', gnosis: '100', celo: '42220', moonbeam: '1284', metis: '1088', kcc: '321', heco: '128' };

async function geckoNetworkId(chain) {
  if (!chain.gecko) return chain.gtNet;          // chain Uniswap com a fonte GeckoTerminal escolhida nas Definições
  if (chain.gecko !== 'auto') return chain.gecko;
  if (!gtNetworks) await loadGtNetworks();
  gtNetworks = gtNetworks || [];
  const hit = gtNetworks.find((n) => chain.match.test(n.name) && !/test/i.test(n.name)) ||
              gtNetworks.find((n) => chain.match.test(n.id.replace(/[-_]/g, ' ')));
  return hit ? hit.id : chain.fallback;
}

// ── Exclusões (escolhidas na interface) ──
// Stablecoins: lista conhecida + qualquer símbolo com USD/EUR/GBP cotado perto de 1.
const STABLES = new Set(['USDC', 'USDT', 'DAI', 'USDC.E', 'USDT.E', 'USDBC', 'BUSD', 'TUSD', 'FDUSD', 'USDE', 'USDS', 'SUSDS', 'PYUSD', 'FRAX', 'FRXUSD', 'LUSD', 'BOLD', 'GUSD', 'USDP', 'USD1', 'RLUSD',
  'CRVUSD', 'GHO', 'SUSDE', 'USD0', 'USD0++', 'USDT0', 'USDB', 'USDX', 'USDD', 'USDA', 'USDZ', 'USDL', 'AUSD', 'DOLA', 'MIM', 'SDAI', 'XDAI', 'EURC', 'EURS', 'EURE', 'EURT', 'AGEUR', 'EURA',
  'USDG', 'USDF', 'SRUSD', 'DEUSD', 'USR', 'RUSD', 'USX', 'CUSD', 'MUSD', 'HUSD', 'ZUSD', 'BUIDL']);
const isStable = (sym, price) => {
  const s = String(sym || '').toUpperCase();
  if (STABLES.has(s)) return true;
  return /(USD|EUR|GBP|CHF)/.test(s) && price > 0 && Math.abs(price - (/(EUR)/.test(s) ? 1.1 : 1)) < 0.06;
};
// Moedas nativas, embrulhadas e liquid staking.
const NATIVES = new Set(['WETH', 'ETH', 'WBNB', 'BNB', 'WMATIC', 'WPOL', 'POL', 'MATIC', 'SOL', 'WSOL',
  // moedas nativas das "outras blockchains"
  'AVAX', 'WAVAX', 'ICP', 'WICP', 'KAS', 'WKAS', 'SUI', 'WSUI', 'TON', 'WTON', 'TRX', 'WTRX', 'CRO', 'WCRO', 'FTM', 'WFTM', 'S', 'WS', 'SEI', 'WSEI', 'NEAR', 'WNEAR', 'APT', 'INJ', 'WINJ', 'CELO', 'MNT', 'WMNT', 'XDAI', 'WXDAI', 'GLMR', 'WGLMR', 'KAVA', 'WKAVA', 'HBAR', 'WHBAR', 'ALGO', 'ADA', 'XRP', 'BERA', 'WBERA', 'HYPE', 'WHYPE', 'MON', 'WMON', 'WBTC', 'CBBTC', 'BTCB', 'TBTC', 'LBTC', 'SOLVBTC', 'STETH', 'WSTETH', 'RETH',
  'CBETH', 'WEETH', 'EETH', 'EZETH', 'RSETH', 'METH', 'OETH', 'FRXETH', 'SFRXETH', 'JITOSOL', 'MSOL', 'BSOL', 'JUPSOL', 'INF', 'WAVAX', 'WARB', 'OP', 'ARB']);
// Ações e fundos tokenizados (xStocks, Ondo, Backed, Robinhood, fundos de tesouraria, ouro…).
const TICKERS = new Set(['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'GOOGL', 'GOOG', 'META', 'NFLX', 'AMD', 'INTC', 'COIN', 'MSTR', 'HOOD', 'PLTR', 'SPY', 'QQQ', 'VOO', 'IVV', 'VTI',
  'GLD', 'SLV', 'TLT', 'IWM', 'DIA', 'ARKK', 'BRK.B', 'BRKB', 'JPM', 'V', 'MA', 'DIS', 'KO', 'PEP', 'MCD', 'NKE', 'BA', 'UBER', 'ABNB', 'SHOP', 'CRCL', 'GME', 'AMC', 'BABA',
  'ORCL', 'CRM', 'ADBE', 'AVGO', 'TSM', 'ASML', 'LLY', 'UNH', 'XOM', 'CVX', 'WMT', 'COST', 'PYPL', 'SQ', 'XYZ', 'SNOW', 'RBLX', 'IBM', 'CSCO', 'QCOM', 'MU', 'ARM', 'SMCI', 'DELL',
  'PFE', 'MRK', 'JNJ', 'ABBV', 'GS', 'MS', 'BAC', 'C', 'WFC', 'T', 'VZ', 'SBUX', 'TGT', 'HD', 'LOW', 'CAT', 'GE', 'F', 'GM', 'RIVN', 'LCID', 'NIO', 'SOFI', 'AFRM', 'RDDT', 'SNAP',
  'CSPX', 'IB01', 'IBTA', 'EUTBL', 'SCHD', 'VUG', 'VGT', 'XLK', 'XLE', 'XLF', 'SMH', 'SOXX', 'TQQQ', 'SQQQ']);
const FUNDS = new Set(['BUIDL', 'BENJI', 'USYC', 'OUSG', 'USTB', 'USDY', 'TBILL', 'STBT', 'JTRSY', 'JAAA', 'ACRED', 'VBILL', 'WTGXX', 'FOBXX', 'EUTBL', 'USTBL', 'OUSG', 'TBY',
  'PAXG', 'XAUT', 'XAUM', 'KAU', 'KAG', 'CACHE', 'PMGT', 'DGX', 'SYRUPUSDC', 'MTBILL', 'MBASIS', 'BCSPX', 'BIB01', 'BNVDA', 'BCOIN', 'BMSTR', 'BHIGH', 'BERNA']);
const isTokenized = (sym, name) => {
  const s = String(sym || '').toUpperCase().trim(); const n = String(name || '');
  if (FUNDS.has(s) || TICKERS.has(s)) return true;
  // xStocks (TSLAx), Ondo (TSLAon), Backed (bNVDA), Dinari (TSLA.d), Robinhood (TSLA.R / rTSLA)
  const base = s.replace(/^(B|R|D)(?=[A-Z]{2,5}$)/, '').replace(/(X|ON|\.D|\.R|-R|D)$/, '');
  if (base !== s && TICKERS.has(base)) return true;
  return /(xStock|tokenized|tokenised|\bstock\b|\bETF\b|treasury|t-?bill|money market|\bfund\b|ondo global|backed finance|dinari|robinhood stock)/i.test(n);
};
// RWA (ativos reais tokenizados): ouro e metais, títulos do tesouro, crédito privado, imobiliário.
// São tokens que representam o ativo — não os tokens de governo de projetos RWA (ONDO, CFG, PLUME…).
const RWA = new Set(['PAXG', 'XAUT', 'XAUM', 'KAU', 'KAG', 'CACHE', 'PMGT', 'DGX', 'AWG', 'XAU', 'XAG', 'GOLD', 'SLVR',
  'BUIDL', 'BENJI', 'USYC', 'OUSG', 'USTB', 'USDY', 'TBILL', 'STBT', 'JTRSY', 'JAAA', 'ACRED', 'VBILL', 'WTGXX', 'FOBXX', 'EUTBL', 'USTBL', 'TBY',
  'MTBILL', 'MBASIS', 'SYRUPUSDC', 'SYRUPUSDT', 'USCC', 'USDTB', 'BCSPX', 'BIB01', 'BHIGH', 'BERNA', 'LTRY', 'OBTC', 'EXOD', 'PRIME', 'REALTOKEN', 'LABITCONF']);
const isRwa = (sym, name) => {
  const s = String(sym || '').toUpperCase().trim(); const n = String(name || '');
  if (RWA.has(s)) return true;
  return /(tokeni[sz]ed gold|\bgold\b|\bsilver\b|platinum|real ?estate|realtoken|\btreasur(y|ies)\b|t-?bill|\bbond(s)?\b|private credit|money market|\bcommodit|\bRWA\b|real[- ]world asset)/i.test(n);
};
function excluded(f, sym, name, price) {
  if (f.exRwa && isRwa(sym, name)) return true;
  if (f.exNative && NATIVES.has(String(sym || '').toUpperCase())) return true;
  if (f.exStable && isStable(sym, price)) return true;
  if (f.exStocks && isTokenized(sym, name)) return true;
  return false;
}

// Filtros anti-pico para o ATH: um "high" diário só conta se o dia teve volume real.
const ATH_MIN_DAY_VOL = 1000;   // USD
const ATH_MAX_WICK = 5;         // high ≤ 5× close do mesmo dia
// Máximo / mínimo local (velas diárias): fecho acima (abaixo) de todos os fechos dos B dias antes e dos A dias depois.
// Predefinição: máximo = 6 semanas antes / 7 dias depois; mínimo = 7 dias antes / 4 semanas depois. Escolhe-se nas Definições.
const LOCAL_DEFAULT = { hb: 42, ha: 7, lb: 7, la: 28 };
function parseLocal(x) {
  const n = (v, d) => { v = Math.round(Number(v)); return Number.isFinite(v) && v >= 1 && v <= 365 ? v : d; };
  x = x || {};
  return { hb: n(x.hb, LOCAL_DEFAULT.hb), ha: n(x.ha, LOCAL_DEFAULT.ha), lb: n(x.lb, LOCAL_DEFAULT.lb), la: n(x.la, LOCAL_DEFAULT.la) };
}
const MAX_CANDIDATES = 600;     // tokens EVM com histórico completo por pesquisa
const GECKO_MAX_CANDIDATES = 45;

// ───────────────────────── Mensagens do servidor (idiomas) ─────────────────────────
const SMSG = {
  en: {
    riskCheck: 'Checking scam risk (GoPlus) {d}/{n}', riskFail: 'Scam check unavailable on {chain} ({err})',
    unavailable: '{src}: unavailable ({err})', noPools: 'no {v} pools indexed on this blockchain', noTdd: 'subgraph without daily token data', noDex: 'GeckoTerminal has no {dex} pools on this blockchain', sgBroken: 'subgraph broken at the indexers, waiting for a fix by its publisher', staleSg: 'subgraph stopped updating on {d}',
    volTokens: '{src}: {n} tokens with volume (page {p})', noSubgraph: 'No subgraph for this blockchain responded.',
    pricesRead: '{src}: prices and supply loaded', candidates: '{n} candidates — reading daily history',
    history: '{src}: history {d}/{n}', hourly: '{src}: hourly data for {n} tokens',
    gtRate: 'GeckoTerminal: rate limit exceeded, try again in a minute', gtNoNet: 'GeckoTerminal has no data for network "{net}" ({err})',
    gtPools: '{n} tokens (pools by volume, page {p}/{t})', gtNew: 'new pools, page {p}/{t}',
    lpCheck: 'checking burned/locked liquidity', cgList: 'gas coins list (CoinGecko)', cgHist: 'history {i}/{n} (CoinGecko)', cgRate: 'CoinGecko is limiting requests; try again in a minute', othersNoNet: 'no DEX networks found on GeckoTerminal', gtHist: 'history {i}/{n} (GeckoTerminal, 30 requests/min)', gtHour: 'hourly data {k}/{n}',
    badAddr: 'Invalid address. Use the contract address (0x… on EVM, or the mint on Solana).', unknownChain: 'Unknown blockchain.',
    wrongFormat: 'This address does not have the {chain} format.', busy: 'The server is busy with other searches. Try again in a minute.',
    notFound: 'Token not found on {chain}.', notFoundAny: 'Token not found on any blockchain.', pickChain: 'Choose at least one blockchain.',
    noKey: 'The Graph API key is missing', noneResponded: 'None of the selected blockchains responded.', keyRejected: 'The Graph rejected the key: {err}',
    pass: 'Password required.', rateLimited: 'Search limit reached ({n} per hour). Try again in {m} min.', lookupLimited: 'Lookup limit reached ({n} per hour). Try again in {m} min.',
  },
  es: {
    riskCheck: 'Comprobando riesgo de estafa (GoPlus) {d}/{n}', riskFail: 'Comprobación de estafas no disponible en {chain} ({err})',
    unavailable: '{src}: no disponible ({err})', noPools: 'no hay pools {v} indexados en esta blockchain', noTdd: 'subgraph sin datos diarios de tokens', noDex: 'GeckoTerminal no tiene pools de {dex} en esta blockchain', sgBroken: 'subgraph averiado en los indexadores, a la espera de que lo corrija quien lo publica', staleSg: 'el subgraph dejó de actualizarse el {d}',
    volTokens: '{src}: {n} tokens con volumen (página {p})', noSubgraph: 'Ningún subgraph de esta blockchain respondió.',
    pricesRead: '{src}: precios y supply leídos', candidates: '{n} candidatos — leyendo el historial diario',
    history: '{src}: historial {d}/{n}', hourly: '{src}: datos por hora de {n} tokens',
    gtRate: 'GeckoTerminal: límite de peticiones superado, prueba dentro de un minuto', gtNoNet: 'GeckoTerminal no tiene datos de la red "{net}" ({err})',
    gtPools: '{n} tokens (pools por volumen, página {p}/{t})', gtNew: 'pools nuevos, página {p}/{t}',
    lpCheck: 'comprobando liquidez quemada/bloqueada', cgList: 'lista de monedas de gas (CoinGecko)', cgHist: 'historial {i}/{n} (CoinGecko)', cgRate: 'CoinGecko está limitando las peticiones; inténtalo dentro de un minuto', othersNoNet: 'no se encontraron redes DEX en GeckoTerminal', gtHist: 'historial {i}/{n} (GeckoTerminal, 30 peticiones/min)', gtHour: 'datos por hora {k}/{n}',
    badAddr: 'Dirección no válida. Usa la del contrato (0x… en EVM, o el mint en Solana).', unknownChain: 'Blockchain desconocida.',
    wrongFormat: 'Esta dirección no tiene el formato de {chain}.', busy: 'El servidor está ocupado con otras búsquedas. Prueba dentro de un minuto.',
    notFound: 'Token no encontrado en {chain}.', notFoundAny: 'Token no encontrado en ninguna blockchain.', pickChain: 'Elige al menos una blockchain.',
    noKey: 'falta la clave API de The Graph', noneResponded: 'Ninguna de las blockchains elegidas respondió.', keyRejected: 'The Graph rechazó la clave: {err}',
    pass: 'Se requiere contraseña.', rateLimited: 'Límite de búsquedas alcanzado ({n} por hora). Prueba dentro de {m} min.', lookupLimited: 'Límite de consultas alcanzado ({n} por hora). Prueba dentro de {m} min.',
  },
  ru: {
    riskCheck: 'Проверка на скам (GoPlus) {d}/{n}', riskFail: 'Проверка на скам недоступна для {chain} ({err})',
    unavailable: '{src}: недоступен ({err})', noPools: 'в этом блокчейне нет проиндексированных пулов {v}', noTdd: 'в subgraph нет дневных данных токенов', noDex: 'в GeckoTerminal нет пулов {dex} в этом блокчейне', sgBroken: 'subgraph сломан у индексаторов, ждём исправления от издателя', staleSg: 'subgraph перестал обновляться {d}',
    volTokens: '{src}: токенов с объёмом: {n} (страница {p})', noSubgraph: 'Ни один subgraph этого блокчейна не ответил.',
    pricesRead: '{src}: цены и эмиссия загружены', candidates: 'кандидатов: {n} — читаем дневную историю',
    history: '{src}: история {d}/{n}', hourly: '{src}: почасовые данные для {n} токенов',
    gtRate: 'GeckoTerminal: превышен лимит запросов, попробуйте через минуту', gtNoNet: 'У GeckoTerminal нет данных по сети "{net}" ({err})',
    gtPools: 'токенов: {n} (пулы по объёму, страница {p}/{t})', gtNew: 'новые пулы, страница {p}/{t}',
    lpCheck: 'проверка сожжённой/заблокированной ликвидности', cgList: 'список газовых монет (CoinGecko)', cgHist: 'история {i}/{n} (CoinGecko)', cgRate: 'CoinGecko ограничивает запросы; попробуйте через минуту', othersNoNet: 'в GeckoTerminal не найдены DEX-сети', gtHist: 'история {i}/{n} (GeckoTerminal, 30 запросов/мин)', gtHour: 'почасовые данные {k}/{n}',
    badAddr: 'Неверный адрес. Укажите адрес контракта (0x… в EVM или mint в Solana).', unknownChain: 'Неизвестный блокчейн.',
    wrongFormat: 'Этот адрес не соответствует формату {chain}.', busy: 'Сервер занят другими поисками. Попробуйте через минуту.',
    notFound: 'Токен не найден в {chain}.', notFoundAny: 'Токен не найден ни в одном блокчейне.', pickChain: 'Выберите хотя бы один блокчейн.',
    noKey: 'нет API-ключа The Graph', noneResponded: 'Ни один из выбранных блокчейнов не ответил.', keyRejected: 'The Graph отклонил ключ: {err}',
    pass: 'Требуется пароль.', rateLimited: 'Достигнут лимит поисков ({n} в час). Попробуйте через {m} мин.', lookupLimited: 'Достигнут лимит запросов ({n} в час). Попробуйте через {m} мин.',
  },
  zh: {
    riskCheck: '正在检查诈骗风险（GoPlus）{d}/{n}', riskFail: '{chain} 暂无法进行诈骗检查（{err}）',
    unavailable: '{src}：不可用（{err}）', noPools: '此链上没有已索引的 {v} 资金池', noTdd: 'subgraph 缺少代币日数据', noDex: 'GeckoTerminal 在此链上没有 {dex} 资金池', sgBroken: 'subgraph 在索引节点出错，等待发布者修复', staleSg: 'subgraph 已于 {d} 停止更新',
    volTokens: '{src}：{n} 个有交易量的代币（第 {p} 页）', noSubgraph: '此链的 subgraph 均无响应。',
    pricesRead: '{src}：已读取价格和供应量', candidates: '{n} 个候选 — 正在读取日线历史',
    history: '{src}：历史 {d}/{n}', hourly: '{src}：{n} 个代币的小时数据',
    gtRate: 'GeckoTerminal：超出请求频率限制，请一分钟后再试', gtNoNet: 'GeckoTerminal 没有网络 "{net}" 的数据（{err}）',
    gtPools: '{n} 个代币（按交易量排序的资金池，第 {p}/{t} 页）', gtNew: '新资金池，第 {p}/{t} 页',
    lpCheck: '正在检查已销毁/锁定的流动性', cgList: 'Gas 币列表（CoinGecko）', cgHist: '历史 {i}/{n}（CoinGecko）', cgRate: 'CoinGecko 正在限制请求，请一分钟后再试', othersNoNet: '在 GeckoTerminal 上没有找到 DEX 网络', gtHist: '历史 {i}/{n}（GeckoTerminal，每分钟 30 次请求）', gtHour: '小时数据 {k}/{n}',
    badAddr: '地址无效。请使用合约地址（EVM 为 0x…，Solana 为 mint 地址）。', unknownChain: '未知的区块链。',
    wrongFormat: '此地址不是 {chain} 的格式。', busy: '服务器正忙于其他搜索，请一分钟后再试。',
    notFound: '在 {chain} 上未找到该代币。', notFoundAny: '在所有链上都未找到该代币。', pickChain: '请至少选择一条链。',
    noKey: '缺少 The Graph API 密钥', noneResponded: '所选的链均无响应。', keyRejected: 'The Graph 拒绝了该密钥：{err}',
    pass: '需要密码。', rateLimited: '已达到搜索上限（每小时 {n} 次）。请在 {m} 分钟后再试。', lookupLimited: '已达到查询上限（每小时 {n} 次）。请在 {m} 分钟后再试。',
  },
  pt: {
    riskCheck: 'A verificar risco de scam (GoPlus) {d}/{n}', riskFail: 'Verificação de scam indisponível em {chain} ({err})',
    unavailable: '{src}: indisponível ({err})', noPools: 'não há pools {v} indexadas nesta blockchain', noTdd: 'subgraph sem dados diários de tokens', noDex: 'o GeckoTerminal não tem pools {dex} nesta blockchain', sgBroken: 'subgraph avariado nos indexadores, à espera que quem o publica o corrija', staleSg: 'o subgraph deixou de atualizar em {d}',
    volTokens: '{src}: {n} tokens com volume (página {p})', noSubgraph: 'Nenhum subgraph desta blockchain respondeu.',
    pricesRead: '{src}: preços e supply lidos', candidates: '{n} candidatos — a ler histórico diário',
    history: '{src}: histórico {d}/{n}', hourly: '{src}: dados horários de {n} tokens',
    gtRate: 'GeckoTerminal: limite de pedidos excedido, tenta daqui a um minuto', gtNoNet: 'GeckoTerminal não tem dados para a rede "{net}" ({err})',
    gtPools: '{n} tokens (pools por volume, página {p}/{t})', gtNew: 'pools novas, página {p}/{t}',
    lpCheck: 'a verificar a liquidez queimada/bloqueada', cgList: 'lista de moedas de gas (CoinGecko)', cgHist: 'histórico {i}/{n} (CoinGecko)', cgRate: 'o CoinGecko está a limitar os pedidos; tenta daqui a um minuto', othersNoNet: 'não foram encontradas redes DEX no GeckoTerminal', gtHist: 'histórico {i}/{n} (GeckoTerminal, 30 pedidos/min)', gtHour: 'dados horários {k}/{n}',
    badAddr: 'Endereço inválido. Usa o contrato (0x… em EVM, ou o mint em Solana).', unknownChain: 'Blockchain desconhecida.',
    wrongFormat: 'Este endereço não tem o formato de {chain}.', busy: 'O servidor está ocupado com outras pesquisas. Tenta daqui a um minuto.',
    notFound: 'Token não encontrado em {chain}.', notFoundAny: 'Token não encontrado em nenhuma das blockchains.', pickChain: 'Escolhe pelo menos uma blockchain.',
    noKey: 'falta a chave da The Graph', noneResponded: 'Nenhuma das blockchains escolhidas respondeu.', keyRejected: 'The Graph recusou a chave: {err}',
    pass: 'Palavra-passe necessária.', rateLimited: 'Limite de pesquisas atingido ({n} por hora). Tenta daqui a {m} min.', lookupLimited: 'Limite de consultas atingido ({n} por hora). Tenta daqui a {m} min.',
  },
};
function tr(lang, k, v) {
  let s = (SMSG[lang] && SMSG[lang][k]) || SMSG.en[k] || k;
  if (v) for (const [a, b] of Object.entries(v)) s = s.split('{' + a + '}').join(String(b));
  return s;
}
// Erro com código traduzível (a mensagem final depende do idioma de quem pesquisa).
class UErr extends Error { constructor(code, vars) { super(code); this.code = code; this.vars = vars || {}; } }
const msgOf = (e, lang) => (e && e.code ? tr(lang, e.code, e.vars) : (e && e.message) || String(e));
const pickLang = (l) => (['en', 'es', 'ru', 'zh', 'pt'].includes(l) ? l : 'en');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
const todayStart = () => Math.floor(Date.now() / 1000 / DAY) * DAY;

// ───────────────────────── The Graph ─────────────────────────
async function gql(key, id, query) {
  const url = `${GATEWAY}/${key}/subgraphs/id/${id}`;
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }), signal: AbortSignal.timeout(45000),
      });
      const text = await res.text();
      let body; try { body = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`); }
      if (body.errors && body.errors.length) {
        const msg = body.errors.map((e) => e.message).join('; ');
        if (/auth|api key|invalid|payment|billing/i.test(msg)) { const e = new Error(msg); e.fatal = true; throw e; }
        throw new Error(msg);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return body.data;
    } catch (e) {
      last = e;
      if (e.fatal) throw e;
      await sleep(800 * (attempt + 1));
    }
  }
  throw last;
}

const profiles = new Map();
async function getProfile(key, id) {
  if (profiles.has(id)) return profiles.get(id);
  const d = await gql(key, id, `{
    tok: __type(name:"Token"){ fields{ name } }
    tdd: __type(name:"TokenDayData"){ fields{ name } }
    bun: __type(name:"Bundle"){ fields{ name } }
    thd: __type(name:"TokenHourData"){ fields{ name } }
  }`);
  // subgraph parado (indexação avariada) = dados velhos: não serve para preço atual nem ATH
  try {
    const m = await gql(key, id, '{ _meta { block { timestamp } } }');
    const ts = Number(m._meta?.block?.timestamp);
    if (ts && Date.now() / 1000 - ts > 2 * DAY) throw new UErr('staleSg', { d: new Date(ts * 1000).toISOString().slice(0, 10) });
  } catch (e) { if (e instanceof UErr || e.fatal) throw e; }
  const f = (t) => new Set((d[t]?.fields || []).map((x) => x.name));
  const tok = f('tok'), tdd = f('tdd'), bun = f('bun'), thd = f('thd');
  const p = {
    vol: tdd.has('volumeUSD') ? 'volumeUSD' : 'dailyVolumeUSD',
    high: tdd.has('high') ? 'high' : null,
    close: tdd.has('close') ? 'close' : 'priceUSD',
    hasPrice: tdd.has('priceUSD'),
    derived: ['derivedETH', 'derivedNative', 'derivedBNB', 'derivedUSD'].find((x) => tok.has(x)) || null,   // PancakeSwap V2: derivedBNB / derivedUSD
    bundle: ['ethPriceUSD', 'nativePriceUSD', 'ethPrice', 'bnbPrice'].find((x) => bun.has(x)) || null,
    supply: tok.has('totalSupply'),
    tvl: ['totalValueLocked', 'totalLiquidity'].find((x) => tok.has(x)) || null,
    hour: thd.has('periodStartUnix') && (thd.has('close') || thd.has('priceUSD')),
    hourOpen: thd.has('open'),
    hourClose: thd.has('close') ? 'close' : 'priceUSD',
  };
  if (!tdd.size) throw new UErr('noTdd');
  profiles.set(id, p);
  return p;
}

// Fonte de dados de uma chain: as que só existem no GeckoTerminal usam-no sempre; as chains Uniswap
// usam-no quando o utilizador escolhe "GeckoTerminal" nas Definições (source: 'gecko').
const useGecko = (k, source) => !!CHAINS[k].gecko || (source === 'gecko' && !!CHAINS[k].gtNet);

// Cada fonte pode ter subgraphs alternativos (alt): usa o primeiro que funcionar e tenha dados diários.
// Os que falham ficam de lado 10 min, para não atrasar as pesquisas seguintes.
const badIds = new Map();
async function resolveSrc(key, src) {
  const ids = [src.id, ...(src.alt || [])];
  let last;
  for (const id of ids) {
    const bad = badIds.get(id);
    if (bad && Date.now() - bad.at < 10 * 60 * 1000) { last = last || bad.e; continue; }
    try { const p = await getProfile(key, id); return { p, src: { ...src, id } }; }
    catch (e) {
      if (e.fatal) throw e;
      // mensagem do gateway ("bad indexers: {0x…: BadResponse(no attestation: indexing_error)…}") → texto curto
      if (!e.code && /indexing_error/i.test(String(e.message))) e = new UErr('sgBroken');
      last = last || e;
      // só fica de lado o que é permanente (sem dados diários, parado, indexação avariada);
      // falhas passageiras (timeout, excesso de pedidos) voltam a ser tentadas na pesquisa seguinte
      if (e.code === 'noTdd' || e.code === 'staleSg' || e.code === 'sgBroken' || /indexing_error|has no field/i.test(String(e.message))) badIds.set(id, { at: Date.now(), e });
    }
  }
  throw last || new UErr('noTdd');   // mostra o erro do subgraph principal
}

// Cache de histórico (30 min) para pesquisas repetidas serem rápidas.
const histCache = new Map();
const HIST_TTL = 30 * 60 * 1000;

async function scanEvm(chainKey, f, key, emit) {
  const chain = CHAINS[chainKey];
  const now = todayStart();
  const since = now - 6 * DAY;   // janela de 7 dias, hoje incluído
  const floor = Math.max(f.volMin, 50);

  // 1) Descoberta: qualquer token cuja média ≥ X teve pelo menos um dia ≥ X.
  const found = new Map(); // id -> {maxDay, sources:Set}
  const live = [];          // fontes que responderam
  const liqSrcs = [];       // fontes que contam para a liquidez
  const srcs = chain.sources.filter((s) => f.versions.has(s.ver));
  if (!srcs.length) throw new UErr('noPools', { v: [...f.versions].join('/') });
  for (const src0 of srcs) {
    let p, src;
    try { ({ p, src } = await resolveSrc(key, src0)); } catch (e) { if (e.fatal) throw e; emit({ type: 'warn', down: src0.ver, msg: tr(f.lang, 'unavailable', { src: src0.name, err: msgOf(e, f.lang) }) }); continue; }
    if (p.tvl && f.wantLiq) liqSrcs.push({ ...src, p });
    live.push({ ...src, p });
    let cursor = null; let pages = 0;
    while (pages < 8) {
      const lt = cursor != null ? `, ${p.vol}_lt: "${cursor}"` : '';
      const q = `{ rows: tokenDayDatas(first: 1000, orderBy: ${p.vol}, orderDirection: desc,
        where: { date_gte: ${since}, ${p.vol}_gte: "${floor}"${lt} }) { token { id } v: ${p.vol} } }`;
      const d = await gql(key, src.id, q);
      const rows = d.rows || [];
      for (const r of rows) {
        const id = r.token.id; const v = num(r.v);
        const cur = found.get(id) || { maxDay: 0, sources: new Set() };
        cur.maxDay = Math.max(cur.maxDay, v); cur.sources.add(src.name); found.set(id, cur);
      }
      pages++;
      emit({ type: 'progress', msg: tr(f.lang, 'volTokens', { src: src.name, n: found.size, p: pages }), pct: 5 + pages * 2 });
      if (rows.length < 1000) break;
      cursor = rows[rows.length - 1].v;
    }
  }
  if (!live.length) throw new UErr('noSubgraph');

  // 2) Metadados + preço atual + FDV (preço de cada fonte; fica o da fonte com mais volume).
  const ids = [...found.keys()];
  const meta = new Map();
  const tvlAmt = new Map(); // id -> tokens bloqueados nas pools das versões escolhidas
  for (const src of live) {
    const p = src.p;
    const wantLiq = !!(p.tvl && f.wantLiq);
    let nativeUsd = 0;
    if (p.bundle) { const b = await gql(key, src.id, `{ bundles(first:1){ x: ${p.bundle} } }`); nativeUsd = num(b.bundles?.[0]?.x); }
    try {
      for (let i = 0; i < ids.length; i += 900) {
        const chunk = ids.slice(i, i + 900);
        const q = `{ tokens(first: 1000, where: { id_in: ${JSON.stringify(chunk)} }) {
            id symbol name decimals ${p.supply ? 'totalSupply' : ''} ${p.derived ? `d: ${p.derived}` : ''} ${wantLiq ? `tv: ${p.tvl}` : ''} } }`;
        const d = await gql(key, src.id, q);
        for (const t of d.tokens || []) {
          if (wantLiq) tvlAmt.set(t.id, (tvlAmt.get(t.id) || 0) + Math.max(0, num(t.tv)));
          const m = meta.get(t.id) || { id: t.id, symbol: t.symbol, name: t.name, decimals: Number(t.decimals) || 0, supply: 0, prices: {} };
          if (t.totalSupply && num(t.totalSupply) > 0) m.supply = Math.max(m.supply, num(t.totalSupply) / Math.pow(10, m.decimals));
          if (p.derived === 'derivedUSD') m.prices[src.name] = num(t.d);
          else if (p.derived && nativeUsd) m.prices[src.name] = num(t.d) * nativeUsd;
          meta.set(t.id, m);
        }
      }
    } catch (e) { throw e; }
    emit({ type: 'progress', msg: tr(f.lang, 'pricesRead', { src: src.name }), pct: 30 });
  }
  // Liquidez ≈ 2 × (tokens bloqueados nas pools × preço): conta os dois lados das pools, com o nosso preço (não o USD do subgraph).
  const liqOf = (id, price) => (liqSrcs.length && price > 0 ? 2 * (tvlAmt.get(id) || 0) * price : null);

  // Pré-filtro (FDV aproximada já com preço atual; média de volume ainda provisória).
  let cands = [];
  for (const [id, info] of found) {
    const m = meta.get(id); if (!m) continue;
    if (excluded(f, m.symbol, m.name, Math.max(0, ...Object.values(m.prices)))) continue;
    const price = Math.max(0, ...Object.values(m.prices));
    const fdv = m.supply && price ? m.supply * price : null;
    if (!fdvOk(fdv, f, 1.3)) continue;          // folga de 30% — o preço final pode diferir
    if (!liqOk(liqOf(id, price), f, 1.3)) continue;
    if (f.volMax != null && info.maxDay / 7 > f.volMax) continue; // média ≥ maior dia / 7
    cands.push({ id, info, m, px: { fdv, liq: liqOf(id, price), price, vol: info.maxDay } });
  }
  // Se houver mais candidatos do que o limite, ficam os melhores segundo a coluna de ordenação
  // (quando há um valor aproximado antes do histórico: FDV, liquidez, preço, volume); senão, por volume.
  preSort(cands, f, (c) => c.px);
  let truncated = false;
  if (cands.length > MAX_CANDIDATES) { cands = cands.slice(0, MAX_CANDIDATES); truncated = true; }
  emit({ type: 'progress', msg: tr(f.lang, 'candidates', { n: cands.length }), pct: 35 });

  // 3) Histórico diário completo de cada candidato, em cada fonte.
  const hist = new Map(); // id -> Map(date -> {vol, high, close, closeVol})
  for (const [si, src] of live.entries()) {
    const p = src.p;
    const need = cands.filter((c) => c.info.sources.has(src.name) || Object.keys(c.m.prices).includes(src.name)).map((c) => c.id);
    const fields = `date v: ${p.vol} c: ${p.close} ${p.high ? 'h: ' + p.high : ''}`;
    let done = 0;
    const B = 20;
    for (let i = 0; i < need.length; i += B) {
      const batch = need.slice(i, i + B);
      const todo = [];
      for (const id of batch) {
        const ck = `${src.id}:${id}`; const c = histCache.get(ck);
        if (c && Date.now() - c.at < HIST_TTL) mergeHist(hist, id, c.rows, src.name); else todo.push(id);
      }
      let pending = todo.map((id) => ({ id, before: null, rows: [] }));
      while (pending.length) {
        const q = '{' + pending.map((x, k) => `t${k}: tokenDayDatas(first: 1000, orderBy: date, orderDirection: desc,
          where: { token: "${x.id}"${x.before ? `, date_lt: ${x.before}` : ''} }) { ${fields} }`).join('\n') + '}';
        const d = await gql(key, src.id, q);
        const next = [];
        pending.forEach((x, k) => {
          const rows = d[`t${k}`] || [];
          x.rows.push(...rows);
          if (rows.length === 1000 && x.rows.length < 4000) next.push({ ...x, before: rows[rows.length - 1].date });
          else { histCache.set(`${src.id}:${x.id}`, { at: Date.now(), rows: x.rows }); mergeHist(hist, x.id, x.rows, src.name); }
        });
        pending = next;
      }
      done += batch.length;
      emit({ type: 'progress', msg: tr(f.lang, 'history', { src: src.name, d: done, n: need.length }), pct: 35 + (60 * si + 60 * done / Math.max(1, need.length)) / live.length });
    }
  }

  // 4) Métricas finais.
  const out = [];
  for (const c of cands) {
    const days = hist.get(c.id); if (!days || !days.size) continue;
    const prices = c.m.prices;
    const best = bestSource(days, prices);
    const r = computeMetrics(days, prices[best] || 0, now, f.local);
    if (!r) continue;
    const fdv = c.m.supply && r.price ? c.m.supply * r.price : null;
    const row = {
      address: c.id, symbol: c.m.symbol, name: c.m.name, link: chain.explorer + c.id,
      sources: [...new Set([...c.info.sources])].join(' + '),
      fdv, ...r, liquidity: liqOf(c.id, r.price),
    };
    hide(row, '_days', days);
    out.push(row);
  }
  // Só os que passam nos filtros recebem os extras (dados horários e gráficos).
  const rows = finalFilter(out, f);
  const hourSrc = live.find((s) => s.p.hour);
  let hourly = new Map();
  if (f.wantHour && hourSrc && rows.length) {
    emit({ type: 'progress', msg: tr(f.lang, 'hourly', { src: hourSrc.name, n: rows.length }), pct: 96 });
    hourly = await fetchHourlyEvm(key, hourSrc, rows.map((r) => r.address), f.hours);
  }
  for (const r of rows) applyExtras(r, r._days, hourly.get(r.address) || null, f);
  return { rows, truncated, scanned: out.length };
}

// Propriedade interna (não vai no JSON).
function hide(o, k, v) { Object.defineProperty(o, k, { value: v, enumerable: false, writable: true }); }

// Velas horárias do subgraph (V3): [{t, o, c}] por ordem crescente.
async function fetchHourlyEvm(key, src, ids, hours) {
  const p = src.p; const nowSec = Math.floor(Date.now() / 1000);
  const since = Math.floor((nowSec - (hours + 2) * 3600) / 3600) * 3600;
  const fields = `t: periodStartUnix c: ${p.hourClose} ${p.hourOpen ? 'o: open' : ''}`;
  const out = new Map(); const B = hours > 24 ? 8 : 25;
  for (let i = 0; i < ids.length; i += B) {
    const batch = ids.slice(i, i + B);
    const q = '{' + batch.map((id, k) => `h${k}: tokenHourDatas(first: ${hours + 3}, orderBy: periodStartUnix, orderDirection: desc,
      where: { token: "${id}", periodStartUnix_gte: ${since} }) { ${fields} }`).join('\n') + '}';
    let d; try { d = await gql(key, src.id, q); } catch (e) { if (e.fatal) throw e; continue; }
    batch.forEach((id, k) => {
      const list = (d[`h${k}`] || []).map((x) => ({ t: Number(x.t), o: x.o != null ? num(x.o) : null, c: num(x.c) }))
        .filter((x) => x.c > 0).sort((a, b) => a.t - b.t);
      out.set(id, list);
    });
  }
  return out;
}

// Preço num instante a partir das velas horárias (interpola dentro da vela; senão último fecho anterior).
function priceAtHour(candles, target) {
  let prev = null;
  for (const k of candles) {
    if (k.t <= target && target < k.t + 3600) {
      const o = k.o > 0 ? k.o : (prev ? prev.c : k.c);
      return o + (k.c - o) * ((target - k.t) / 3600);
    }
    if (k.t + 3600 <= target) prev = k; else break;
  }
  return prev ? prev.c : null;
}

const r6 = (x) => Number(x.toPrecision(6));

// Gráfico diário: fecho de cada dia (dias sem trades repetem o anterior), último ponto = preço atual.
function dailySpark(days, price, now, nDays, step) {
  const dates = [...days.keys()].sort((a, b) => a - b);
  const pts = []; let j = 0; let last = null;
  for (let d = now - nDays * DAY; d <= now; d += DAY) {
    while (j < dates.length && dates[j] <= d) { const c = days.get(dates[j]).close; if (c > 0) last = c; j++; }
    if (last != null) pts.push(last);
  }
  if (!pts.length) return null;
  pts[pts.length - 1] = price;
  const out = [];
  for (let i = (pts.length - 1) % step; i < pts.length; i += step) out.push(r6(pts[i]));
  return out.length >= 2 ? out : null;
}

function hourlySpark(candles, price, hours, step) {
  const nowSec = Math.floor(Date.now() / 1000); const pts = [];
  for (let h = hours; h >= 0; h -= step) { const v = priceAtHour(candles, nowSec - h * 3600); if (v != null) pts.push(r6(v)); }
  if (pts.length < 2) return null;
  pts[pts.length - 1] = r6(price);
  return pts;
}

// Variações horárias + gráficos pedidos, sobre uma linha já calculada.
function applyExtras(row, days, candles, f) {
  const nowSec = Math.floor(Date.now() / 1000);
  const ch = (n) => {
    if (!candles || !candles.length) return row[`chg${n}h`] ?? null;
    if (row.createdAt && row.createdAt > nowSec - n * 3600) return null;
    const v = priceAtHour(candles, nowSec - n * 3600);
    return v > 0 ? (row.price / v - 1) * 100 : null;
  };
  if (f.cols.has('chg1h')) row.chg1h = ch(1);
  if (f.cols.has('chg6h')) row.chg6h = ch(6);
  if (f.cols.has('chg12h')) row.chg12h = ch(12);
  if (days) {
    const now = todayStart();
    if (f.cols.has('sp7')) row.sp7 = (candles && candles.length >= 6 ? hourlySpark(candles, row.price, 168, 3) : null) || dailySpark(days, row.price, now, 7, 1);
    if (f.cols.has('sp30')) row.sp30 = dailySpark(days, row.price, now, 30, 1);
    if (f.cols.has('sp90')) row.sp90 = dailySpark(days, row.price, now, 90, 2);
    if (f.cols.has('sp365')) row.sp365 = dailySpark(days, row.price, now, 365, 5);
  }
}

function mergeHist(hist, id, rows, srcName) {
  let m = hist.get(id); if (!m) { m = new Map(); hist.set(id, m); }
  for (const r of rows) {
    const date = Number(r.date); const v = num(r.v); const c = num(r.c); const h = r.h != null ? num(r.h) : c;
    const e = m.get(date) || { vol: 0, high: 0, close: 0, closeVol: -1, srcVol: {} };
    e.vol += v;
    e.srcVol[srcName] = (e.srcVol[srcName] || 0) + v;
    // Pico anti-ruído: o high só conta com volume real e sem "pavio" absurdo.
    let dayHigh = 0;
    if (v >= ATH_MIN_DAY_VOL && c > 0) dayHigh = Math.min(h || c, c * ATH_MAX_WICK);
    else if (v >= 100 && c > 0) dayHigh = c;
    e.high = Math.max(e.high, dayHigh);
    if (v > e.closeVol && c > 0) { e.close = c; e.closeVol = v; }
    m.set(date, e);
  }
}

function bestSource(days, prices) {
  const tot = {}; const recent = Math.max(...days.keys()) - 7 * DAY;
  for (const [d, e] of days) if (d >= recent) for (const [s, v] of Object.entries(e.srcVol)) tot[s] = (tot[s] || 0) + v;
  let best = null; let bv = -1;
  for (const [s, v] of Object.entries(tot)) if (v > bv && prices[s]) { best = s; bv = v; }
  return best;
}

// Partilhado por EVM e Solana. days: Map(dateStart -> {vol, high, close})
function computeMetrics(days, livePrice, now, local = LOCAL_DEFAULT) {
  const dates = [...days.keys()].sort((a, b) => a - b);
  if (!dates.length) return null;
  const created = dates[0];
  const ageDays = Math.max(0, Math.floor((now - created) / DAY));
  const window = Math.min(7, ageDays + 1);
  const from = now - (window - 1) * DAY;
  let volSum = 0;
  for (const d of dates) if (d >= from) volSum += days.get(d).vol;
  const avgVol = volSum / window;

  const lastClose = days.get(dates[dates.length - 1]).close;
  const price = livePrice > 0 ? livePrice : lastClose;
  if (!(price > 0)) return null;

  let ath = 0; let athDate = created;
  for (const d of dates) { const h = days.get(d).high; if (h > ath) { ath = h; athDate = d; } }
  if (price >= ath) { ath = price; athDate = now; }

  // ATL: o fecho diário mais baixo, só em dias com volume a sério (as mesmas regras anti-pico do ATH).
  let atl = 0; let atlDate = null;
  for (const d of dates) { const e = days.get(d); if (e.close > 0 && e.vol >= ATH_MIN_DAY_VOL && (!atl || e.close < atl)) { atl = e.close; atlDate = d; } }
  if (atl && price < atl) { atl = price; atlDate = now; }

  // Último máximo / mínimo local (velas diárias): o dia mais recente cujo fecho é mais alto (mais baixo) que todos
  // os fechos dos B dias de calendário antes e dos A dias depois. Só dias com volume a sério; hoje (vela aberta)
  // fica de fora. Os dois lados têm de estar completos: um pivô só aparece A dias depois de acontecer.
  const cl = dates.filter((d) => d < now).map((d) => ({ d, c: days.get(d).close, v: days.get(d).vol })).filter((x) => x.c > 0 && x.v >= ATH_MIN_DAY_VOL);
  const pivot = (B, A, high) => {
    for (let i = cl.length - 1; i >= 0; i--) {
      const { d, c } = cl[i];
      if (d + A * DAY > now - DAY) continue;      // ainda não passaram A dias completos
      if (d - B * DAY < cl[0].d) return null;     // já não há B dias de histórico real antes (os anteriores também não)
      let ok = true;
      for (let k = i - 1; k >= 0 && cl[k].d >= d - B * DAY; k--) if (high ? cl[k].c >= c : cl[k].c <= c) { ok = false; break; }
      if (ok) for (let k = i + 1; k < cl.length && cl[k].d <= d + A * DAY; k++) if (high ? cl[k].c > c : cl[k].c < c) { ok = false; break; }
      if (ok) return cl[i];
    }
    return null;
  };
  // colunas escondidas não são calculadas (local.h / local.l = false)
  const lh = local.h === false ? null : pivot(local.hb, local.ha, true);
  const ll = local.l === false ? null : pivot(local.lb, local.la, false);

  // Variação de preço: preço atual vs fecho diário de há N dias (último fecho conhecido até essa data).
  const closeAt = (target) => {
    if (target < created) return null;          // token mais novo que o período
    for (let i = dates.length - 1; i >= 0; i--) {
      if (dates[i] <= target) { const c = days.get(dates[i]).close; if (c > 0) return c; }
    }
    return null;
  };
  const change = (n) => { const c = closeAt(now - n * DAY); return c ? (price / c - 1) * 100 : null; };

  // Volume 24h (estimado a partir dos dados diários): hoje até agora + a parte de ontem que cai nas últimas 24h.
  const elapsed = Math.min(1, Math.max(0, (Date.now() / 1000 - now) / DAY));
  const volToday = days.get(now)?.vol || 0;
  const volYesterday = days.get(now - DAY)?.vol || 0;
  const vol24h = volToday + volYesterday * (1 - elapsed);

  return {
    vol24h,
    chg1d: change(1), chg3d: change(3), chg7d: change(7), chg14d: change(14), chg30d: change(30),
    chg90d: change(90), chg180d: change(180), chg365d: change(365),
    price, avgVol, ageDays, createdAt: created,
    ath, athDate, daysSinceAth: Math.max(0, Math.floor((now - athDate) / DAY)),
    pctOfAth: ath > 0 ? (price / ath) * 100 : 0,
    atl: atl || null, atlDate,
    sinceAtl: atl ? (price / atl - 1) * 100 : null,
    atlDays: atlDate != null ? Math.max(0, Math.floor((now - atlDate) / DAY)) : null,
    lhPrice: lh ? lh.c : null, lhDate: lh ? lh.d : null, lhDays: lh ? Math.floor((now - lh.d) / DAY) : null,
    llPrice: ll ? ll.c : null, llDate: ll ? ll.d : null, llDays: ll ? Math.floor((now - ll.d) / DAY) : null,
  };
}

function liqOk(liq, f, slack = 1) {
  if (liq == null) return f.liqMin <= 0 && f.liqMax == null;
  if (liq < f.liqMin / slack) return false;
  if (f.liqMax != null && liq > f.liqMax * slack) return false;
  return true;
}

function fdvOk(fdv, f, slack = 1) {
  if (fdv == null) return f.fdvMin <= 0 && f.fdvMax == null; // FDV desconhecida só passa sem filtro
  if (fdv < f.fdvMin / slack) return false;
  if (f.fdvMax != null && fdv > f.fdvMax * slack) return false;
  return true;
}

// ───────────────────────── Solana (GeckoTerminal) ─────────────────────────
let gtLast = 0;
async function gt(pathq) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = gtLast + 2100 - Date.now(); if (wait > 0) await sleep(wait); // ~30 pedidos/min
    gtLast = Date.now();
    const res = await fetch(GT_BASE + pathq, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    if (res.status === 429) { await sleep(15000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`GeckoTerminal HTTP ${res.status}`);
    return res.json();
  }
  throw new UErr('gtRate');
}

// budget: quantas páginas e candidatos (menos quando várias chains GeckoTerminal partilham o limite de 30 pedidos/min)
async function scanGecko(chainKey, f, emit, budget = { pages: 10, newPages: 5, cands: GECKO_MAX_CANDIDATES }) {
  const chain = CHAINS[chainKey]; const now = todayStart();
  const net = await geckoNetworkId(chain);
  const tokens = new Map();
  const QUOTES = new Set(['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);
  const liqBy = new Map();
  // Cada pool tem dois tokens: o "base" e o "quote". Os dois entram (antes só o base, e um token que aparecia
  // sempre do lado quote, ex. "WETH / TOKEN", nunca era encontrado na pesquisa mas era na consulta por CA).
  const add = (data) => {
    for (const p of data.data || []) {
      const a = p.attributes; const vol24 = num(a.volume_usd?.h24);
      const names = String(a.name || '').split('/').map((x) => x.trim().split(/\s+/)[0] || '');
      for (const side of ['base', 'quote']) {
        const id = p.relationships?.[side + '_token']?.data?.id || '';
        const addr = id.replace(`${net}_`, '');
        if (!addr || QUOTES.has(addr)) continue;
        const sym = names[side === 'base' ? 0 : 1] || '';
        const price = num(side === 'base' ? a.base_token_price_usd : a.quote_token_price_usd);
        if (excluded(f, sym, sym, price)) continue;       // tira já WETH, USDC, … do lado quote
        // liquidez provisória = soma das reservas das pools vistas (depois é trocada pelo total do GeckoTerminal)
        const L = liqBy.get(addr) || { pools: new Set(), sum: 0 };
        if (!L.pools.has(a.address)) { L.pools.add(a.address); L.sum += num(a.reserve_in_usd); liqBy.set(addr, L); }
        const cur = tokens.get(addr);
        if (!cur || vol24 > cur.vol24) {
          const fdv = side === 'base' ? (a.fdv_usd != null ? num(a.fdv_usd) : (a.market_cap_usd != null ? num(a.market_cap_usd) : null)) : null;
          tokens.set(addr, { addr, side, sym, pool: a.address, name: a.name, vol24, pc: side === 'base' ? (a.price_change_percentage || {}) : {}, fdv, price,
            lock: a.locked_liquidity_percentage != null ? num(a.locked_liquidity_percentage) : null,
            created: a.pool_created_at ? Math.floor(Date.parse(a.pool_created_at) / 1000) : null });
        }
      }
    }
  };
  // Modo "só uma DEX" (ex. Uniswap V4 quando o subgraph falha): só as pools dessa DEX, sem a lista de pools novas.
  const dex = f.gtDex ? GT_DEX[f.gtDex] : null;
  let dexId = null;
  if (dex) { dexId = await geckoDexId(net, dex.re); if (!dexId) throw new UErr('noDex', { dex: dex.label }); }
  const poolsPath = (page) => dexId ? `/networks/${net}/dexes/${dexId}/pools?page=${page}&sort=h24_volume_usd_desc`
    : `/networks/${net}/pools?page=${page}&sort=h24_volume_usd_desc&include=base_token`;
  for (let page = 1; page <= budget.pages; page++) {
    let d;
    try { d = await gt(poolsPath(page)); }
    catch (e) { if (page === 1) throw new UErr('gtNoNet', { net, err: msgOf(e, f.lang) }); break; }
    add(d);
    emit({ type: 'progress', msg: tr(f.lang, 'gtPools', { n: tokens.size, p: page, t: budget.pages }), pct: page * 3 });
    if (!(d.data || []).length) break;
  }
  if (f.minAge < 7 && !dexId) for (let page = 1; page <= budget.newPages; page++) {
    try { add(await gt(`/networks/${net}/new_pools?page=${page}&include=base_token`)); } catch (_) { break; }
    emit({ type: 'progress', msg: tr(f.lang, 'gtNew', { p: page, t: budget.newPages }), pct: 30 + page });
  }
  // 1.ª passagem (larga): só o que já se sabe ao certo. FDV e liquidez ainda são provisórias.
  let cands = [...tokens.values()].filter((t) => {
    if (t.fdv != null && !fdvOk(t.fdv, f, 2)) return false;
    if (f.vol24Min > 0 && t.vol24 < f.vol24Min / 3) return false;   // volume 24h da pool principal (o do token pode ser maior)
    if (f.liqMax != null && (liqBy.get(t.addr)?.sum || 0) > f.liqMax * 2) return false;
    if (t.created && f.minAge > 0 && (now - t.created) / DAY < f.minAge - 1) return false;
    return true;
  });
  // Dados reais do token (como na consulta por CA): FDV, liquidez total em todas as pools, preço, nome. 30 tokens por pedido.
  for (let i = 0; i < cands.length; i += 30) {
    const batch = cands.slice(i, i + 30);
    emit({ type: 'progress', msg: tr(f.lang, 'gtPools', { n: tokens.size, p: budget.pages, t: budget.pages }), pct: 33 });
    let d; try { d = await gt(`/networks/${net}/tokens/multi/${batch.map((t) => t.addr).join(',')}`); } catch (_) { continue; }
    const by = new Map((d.data || []).map((x) => [String(x.attributes?.address || '').toLowerCase(), x.attributes]));
    for (const t of batch) {
      const ta = by.get(t.addr.toLowerCase()); if (!ta) continue;
      if (ta.fdv_usd != null) t.fdv = num(ta.fdv_usd); else if (ta.market_cap_usd != null) t.fdv = num(ta.market_cap_usd);
      if (ta.total_reserve_in_usd != null) t.liq = num(ta.total_reserve_in_usd);
      if (num(ta.price_usd) > 0) t.price = num(ta.price_usd);
      if (ta.symbol) t.sym = ta.symbol; if (ta.name) t.tname = ta.name;
    }
  }
  // 2.ª passagem (exata), com os valores do token.
  cands = cands.filter((t) => {
    if (t.liq == null) t.liq = liqBy.get(t.addr)?.sum ?? null;
    if (excluded(f, t.sym, t.tname || t.name, t.price)) return false;
    if (!fdvOk(t.fdv, f, 1.05)) return false;
    if (!liqOk(t.liq, f, 1.05)) return false;
    return true;
  });
  for (const t of cands) t.px = { fdv: t.fdv, liq: t.liq, price: t.price, vol: t.vol24 };
  preSort(cands, f, (c) => c.px);
  let truncated = false;
  if (cands.length > budget.cands) { cands = cands.slice(0, budget.cands); truncated = true; }

  const out = []; let i = 0;
  for (const t of cands) {
    i++;
    emit({ type: 'progress', msg: tr(f.lang, 'gtHist', { i, n: cands.length }), pct: 36 + Math.round(60 * i / cands.length) });
    let d; try { d = await gt(`/networks/${net}/pools/${t.pool}/ohlcv/day?aggregate=1&limit=1000&currency=usd&token=${t.side}`); } catch (e) { emit({ type: 'warn', msg: `${t.sym || t.name}: ${msgOf(e, f.lang)}` }); continue; }
    const list = d.data?.attributes?.ohlcv_list || [];
    const days = new Map();
    for (const [ts, o, h, l, c, v] of list) {
      const date = Math.floor(ts / DAY) * DAY; const vol = num(v); const close = num(c);
      let high = 0;
      if (vol >= ATH_MIN_DAY_VOL && close > 0) high = Math.min(num(h), close * ATH_MAX_WICK); else if (vol >= 100) high = close;
      days.set(date, { vol, high, close });
    }
    if (t.created) { const cd = Math.floor(t.created / DAY) * DAY; if (!days.has(cd) && cd < Math.min(...days.keys(), Infinity)) days.set(cd, { vol: 0, high: 0, close: 0 }); }
    const r = computeMetrics(days, t.price, now, f.local); if (!r) continue;
    r.athPartial = geckoPartial(list, t.created);
    const ratio = t.price && r.price ? r.price / t.price : 1;
    const row = { address: t.addr, symbol: t.sym || t.name.split('/')[0].trim(), name: t.tname || t.name, link: chain.explorer ? chain.explorer + t.addr : `https://www.geckoterminal.com/${net}/pools/${t.pool}`, sources: dex ? `GeckoTerminal (${dex.label})` : 'GeckoTerminal', fdv: t.fdv != null ? t.fdv * ratio : null, liquidity: t.liq, ...r, vol24h: t.vol24 || r.vol24h,
      chg1h: t.pc.h1 != null ? num(t.pc.h1) : null, chg6h: t.pc.h6 != null ? num(t.pc.h6) : null, lpLock: t.lock };
    hide(row, '_days', days); hide(row, '_pool', t.pool); hide(row, '_side', t.side);
    out.push(row);
  }
  const rows = finalFilter(out, f);
  // 12h e gráfico de 1 semana precisam das velas horárias (1 pedido extra por token).
  const needHour = f.cols.has('chg12h') || f.cols.has('sp7');
  let k = 0;
  for (const r of rows) {
    let candles = null;
    if (needHour) {
      k++; emit({ type: 'progress', msg: tr(f.lang, 'gtHour', { k, n: rows.length }), pct: 97 });
      candles = await geckoHourly(net, r._pool, r._side || 'base');
    }
    applyExtras(r, r._days, candles, f);
  }
  return { rows, truncated, scanned: out.length };
}

async function geckoHourly(net, pool, token = 'base') {
  try {
    const d = await gt(`/networks/${net}/pools/${pool}/ohlcv/hour?aggregate=1&limit=170&currency=usd&token=${token}`);
    return (d.data?.attributes?.ohlcv_list || []).map(([ts, o, h, l, c]) => ({ t: Number(ts), o: num(o), c: num(c) }))
      .filter((x) => x.c > 0).sort((a, b) => a.t - b.t);
  } catch (_) { return null; }
}

// ───────────────────────── Risco / scam (GoPlus Security) ─────────────────────────
// API pública e gratuita, sem chave. Devolve flags por contrato; aqui viram alertas ordenados por gravidade.
const GOPLUS = process.env.GOPLUS_BASE || 'https://api.gopluslabs.io/api/v1';
const GP_CHAIN = { ethereum: '1', bsc: '56', base: '8453', arbitrum: '42161', polygon: '137', optimism: '10' };
const SEV = { crit: 4, high: 3, med: 2, low: 1 };
const riskCache = new Map(); const RISK_TTL = 6 * 3600 * 1000;
let gpLast = 0;
// GoPlus (grátis) aceita poucos pedidos por minuto e responde "too many requests" (HTTP 429 ou código 4029 com HTTP 200).
// Pedidos espaçados 2,5 s; quando recusa, espera 10/20/30 s e tenta outra vez.
let gpBlockedUntil = 0;
async function gpFetch(pathq) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = Math.max(gpLast + 2500, gpBlockedUntil) - Date.now(); if (wait > 0) await sleep(wait);
    gpLast = Date.now();
    const res = await fetch(GOPLUS + pathq, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    let j = null;
    if (res.ok) { try { j = await res.json(); } catch (_) { j = null; } }
    const limited = res.status === 429 || (j && (j.code === 4029 || /too many|rate limit/i.test(String(j.message || ''))));
    if (limited) { gpBlockedUntil = Date.now() + 10000 * (attempt + 1); continue; }
    if (!res.ok) throw new Error(`GoPlus HTTP ${res.status}`);
    if (!j || (j.code !== 1 && j.code !== 2 && !j.result)) throw new Error(`GoPlus: ${(j && (j.message || j.code)) || 'resposta inválida'}`);
    return j.result || {};
  }
  throw Object.assign(new Error('GoPlus: too many requests'), { rateLimited: true });
}
// % das LP queimadas (endereço 0x0…0 / 0x…dead) ou bloqueadas (is_locked), segundo o GoPlus. null = sem dados.
// Endereços de queima conhecidos (EVM). As LP enviadas para aqui nunca mais podem ser levantadas.
const BURN_ADDRS = ['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead',
  '0xdead000000000000000042069420694206942069', '0x0000000000000000000000000000000000000001'];
const isBurn = (a) => BURN_ADDRS.includes(String(a || '').toLowerCase());
const PERMANENT_LOCK = 5 * 365 * DAY;   // bloqueio "permanente" = acaba daqui a mais de 5 anos (ou sem data de fim)
function lpLockPct(g) {
  if (!g || !Array.isArray(g.lp_holders) || !g.lp_holders.length) return null;
  const nowS = Date.now() / 1000;
  const pct = g.lp_holders.reduce((a, h) => {
    const share = Number(h.percent) || 0;
    if (isBurn(h.address)) return a + share;
    if (!on(h.is_locked)) return a;
    const det = Array.isArray(h.locked_detail) ? h.locked_detail : [];
    if (!det.length) return a + share;                               // bloqueado sem data de fim
    const tot = det.reduce((x, d) => x + (Number(d.amount) || 0), 0);
    const perm = det.reduce((x, d) => x + ((Number(d.end_time) || 0) - nowS > PERMANENT_LOCK ? (Number(d.amount) || 0) : 0), 0);
    return a + (tot > 0 ? share * perm / tot : 0);
  }, 0);
  return Math.max(0, Math.min(100, pct * 100));
}

// ── Verificação direta (on-chain) das LP queimadas, nas pools V2 (a LP é um token ERC-20 do próprio par) ──
// totalSupply() e balanceOf(endereços de queima) do par, num só pedido JSON-RPC por lote. Não precisa do GoPlus.
const RPC = {
  ethereum: process.env.RPC_ETHEREUM || 'https://ethereum-rpc.publicnode.com',
  base: process.env.RPC_BASE || 'https://base-rpc.publicnode.com',
  bsc: process.env.RPC_BSC || 'https://bsc-rpc.publicnode.com',
  arbitrum: process.env.RPC_ARBITRUM || 'https://arbitrum-one-rpc.publicnode.com',
  polygon: process.env.RPC_POLYGON || 'https://polygon-bor-rpc.publicnode.com',
  optimism: process.env.RPC_OPTIMISM || 'https://optimism-rpc.publicnode.com',
  'gt:avax': process.env.RPC_AVAX || 'https://avalanche-c-chain-rpc.publicnode.com',
};
const hexBig = (h) => { try { return h && h !== '0x' ? BigInt(h) : 0n; } catch (_) { return 0n; } };
async function burnedPctOnChain(rpcUrl, pairs) {
  const out = new Map();
  for (let i = 0; i < pairs.length; i += 15) {
    const chunk = pairs.slice(i, i + 15); const calls = [];
    chunk.forEach((pair, k) => {
      calls.push({ jsonrpc: '2.0', id: k * 10, method: 'eth_call', params: [{ to: pair, data: '0x18160ddd' }, 'latest'] });
      BURN_ADDRS.forEach((a, j) => calls.push({ jsonrpc: '2.0', id: k * 10 + 1 + j, method: 'eth_call', params: [{ to: pair, data: '0x70a08231' + a.slice(2).padStart(64, '0') }, 'latest'] }));
    });
    let res;
    try {
      const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(calls), signal: AbortSignal.timeout(20000) });
      res = await r.json();
    } catch (_) { continue; }
    if (!Array.isArray(res)) continue;
    const by = new Map(res.map((x) => [x.id, x.result]));
    chunk.forEach((pair, k) => {
      const total = hexBig(by.get(k * 10)); if (total <= 0n) return;    // não é um token LP (ex. pool V3)
      let burned = 0n; BURN_ADDRS.forEach((_, j) => { burned += hexBig(by.get(k * 10 + 1 + j)); });
      out.set(pair, Number((burned * 10000n) / total) / 100);
    });
  }
  return out;
}
// Para as linhas finais: par V2 principal de cada token (subgraph V2) → verificação direta. Sem par V2 ou sem RPC → GoPlus / GeckoTerminal.
async function addLpBurn(rows, key) {
  const byChain = new Map();
  for (const r of rows) { if (r.cex) continue; if (!byChain.has(r.chain)) byChain.set(r.chain, []); byChain.get(r.chain).push(r); }
  for (const [chain, list] of byChain) {
    const pairOf = new Map();
    // par: GeckoTerminal já dá a pool; nas chains da The Graph procura o maior par V2 no subgraph V2
    for (const r of list) if (r._pool && /^0x[0-9a-f]{40}$/i.test(r._pool)) pairOf.set(r.address, r._pool.toLowerCase());
    const v2 = (CHAINS[chain]?.sources || []).find((x) => x.ver === 'V2');
    if (v2 && key) {
      let src = null; try { ({ src } = await resolveSrc(key, v2)); } catch (_) { src = null; }
      const need = list.filter((r) => !pairOf.has(r.address));
      for (let i = 0; src && i < need.length; i += 25) {
        const b = need.slice(i, i + 25);
        const q = '{' + b.map((r, k) => `a${k}: pairs(first: 1, orderBy: reserveUSD, orderDirection: desc, where: { token0: "${r.address}" }) { id reserveUSD }
          b${k}: pairs(first: 1, orderBy: reserveUSD, orderDirection: desc, where: { token1: "${r.address}" }) { id reserveUSD }`).join('\n') + '}';
        let d; try { d = await gql(key, src.id, q); } catch (_) { continue; }
        b.forEach((r, k) => {
          const c = [...(d['a' + k] || []), ...(d['b' + k] || [])].sort((x, y) => num(y.reserveUSD) - num(x.reserveUSD))[0];
          if (c) pairOf.set(r.address, c.id.toLowerCase());
        });
      }
    }
    const rpc = RPC[chain];
    const direct = rpc && pairOf.size ? await burnedPctOnChain(rpc, [...new Set(pairOf.values())]) : new Map();
    for (const r of list) {
      const pair = pairOf.get(r.address); const onchain = pair != null ? direct.get(pair) : undefined;
      const gp = r.risk && r.risk.lp != null ? r.risk.lp : null;
      if (onchain != null) {
        // queimado verificado on-chain; se o GoPlus vir mais (bloqueios permanentes no mesmo par), fica o maior
        r.lp = gp != null && gp > onchain ? { pct: gp, src: 'goplus', pool: pair } : { pct: onchain, src: 'onchain', pool: pair };
      } else if (r.lpLock != null) r.lp = { pct: Math.max(0, Math.min(100, r.lpLock)), src: 'gt', pool: r._pool || null };
      else if (gp != null) r.lp = { pct: gp, src: 'goplus', pool: null };
      else r.lp = null;
    }
  }
}
const on = (v) => v === '1' || v === 1 || v === true || (v && typeof v === 'object' && (v.status === '1' || v.status === 1));
const pc = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// EVM: flags GoPlus → [{k, sev, v}]
function evmFlags(g) {
  const F = [];
  const add = (k, sev, v) => F.push(v == null ? { k, sev } : { k, sev, v });
  if (on(g.is_honeypot)) add('honeypot', 'crit');
  if (on(g.cannot_sell_all)) add('cantSell', 'crit');
  if (on(g.cannot_buy)) add('cantBuy', 'high');
  const sell = pc(g.sell_tax), buy = pc(g.buy_tax);
  if (sell != null && sell >= 0.1) add('sellTax', sell >= 0.5 ? 'crit' : 'high', Math.round(sell * 100));
  if (buy != null && buy >= 0.1) add('buyTax', buy >= 0.5 ? 'crit' : 'high', Math.round(buy * 100));
  if (on(g.owner_change_balance)) add('balanceChange', 'crit');
  if (on(g.honeypot_with_same_creator)) add('sameCreator', 'high');
  if (on(g.transfer_pausable)) add('pausable', 'high');
  if (on(g.is_blacklisted)) add('blacklist', 'high');
  if (on(g.slippage_modifiable) || on(g.personal_slippage_modifiable)) add('taxChangeable', 'high');
  const owner = String(g.owner_address || '');
  const renounced = !owner || /^0x0+$/.test(owner) || /^0x0+dead$/i.test(owner);
  if (on(g.is_mintable) && !renounced) add('mintable', 'high');
  if (on(g.can_take_back_ownership)) add('reclaimOwner', 'high');
  if (on(g.hidden_owner)) add('hiddenOwner', 'high');
  if (on(g.selfdestruct)) add('selfdestruct', 'high');
  if (Array.isArray(g.lp_holders) && g.lp_holders.length) {   // (ver também lpLockPct)
    const locked = g.lp_holders.reduce((a, h) => a + (on(h.is_locked) ? (pc(h.percent) || 0) : 0), 0);
    if (locked < 0.5) add('lpUnlocked', locked < 0.05 ? 'high' : 'med', Math.round(locked * 100));
  }
  if (Array.isArray(g.holders) && g.holders.length) {
    const top = g.holders.filter((h) => !on(h.is_locked) && !on(h.is_contract)).slice(0, 10).reduce((a, h) => a + (pc(h.percent) || 0), 0);
    if (top >= 0.5) add('whales', top >= 0.8 ? 'high' : 'med', Math.round(top * 100));
  }
  const cr = (pc(g.creator_percent) || 0) + (pc(g.owner_percent) || 0);
  if (cr >= 0.2) add('creator', cr >= 0.5 ? 'high' : 'med', Math.round(cr * 100));
  if (on(g.is_proxy)) add('proxy', 'med');
  if (g.is_open_source === '0' || g.is_open_source === 0) add('unverified', 'med');
  if (on(g.trading_cooldown)) add('cooldown', 'low');
  if (on(g.external_call)) add('external', 'low');
  return F;
}
// Solana: flags GoPlus → [{k, sev, v}]
function solFlags(g) {
  const F = [];
  const add = (k, sev, v) => F.push(v == null ? { k, sev } : { k, sev, v });
  if (on(g.non_transferable)) add('nonTransferable', 'crit');
  if (on(g.balance_mutable_authority)) add('balanceChange', 'crit');
  if (on(g.freezable)) add('freezable', 'high');
  if (on(g.mintable)) add('mintable', 'high');
  const fee = g.transfer_fee && (pc(g.transfer_fee.current_fee_rate) ?? pc(g.transfer_fee.fee_rate));
  if (fee != null && fee >= 0.05) add('transferFee', fee >= 0.5 ? 'crit' : 'high', Math.round(fee * 100));
  if (on(g.closable)) add('closable', 'med');
  if (Array.isArray(g.holders) && g.holders.length) {
    const top = g.holders.slice(0, 10).reduce((a, h) => a + (pc(h.percent) || 0), 0);
    if (top >= 0.5) add('whales', top >= 0.8 ? 'high' : 'med', Math.round(top * 100));
  }
  if (on(g.metadata_mutable)) add('metaMutable', 'low');
  return F;
}
function sortFlags(F) { return F.sort((a, b) => SEV[b.sev] - SEV[a.sev]); }

// Junta {risk:{src, flags}} às linhas (só as que passaram nos filtros). Chains sem suporte ficam com src:null.
async function addRisk(rows, lang, emit) {
  const byChain = new Map();
  for (const r of rows) { if (!byChain.has(r.chain)) byChain.set(r.chain, []); byChain.get(r.chain).push(r); }
  let done = 0; const total = rows.length; const warned = new Set();
  for (const [chain, list] of byChain) {
    const sol = chain === 'solana'; const gp = sol ? 'solana' : (GP_CHAIN[chain] || GP_GT[CHAINS[chain]?.gecko]);
    // moedas de gas (CEX) não têm contrato para verificar: risco "não se aplica"
    if (!gp) { for (const r of list) r.risk = r.cex ? { src: null, flags: [], na: true } : { src: null, flags: [] }; done += list.length; continue; }
    const todo = [];
    for (const r of list) {
      const c = riskCache.get(chain + ':' + r.address);
      if (c && Date.now() - c.at < RISK_TTL) r.risk = c.risk; else todo.push(r);
    }
    done += list.length - todo.length;
    const B = 20;
    for (let i = 0; i < todo.length; i += B) {
      const batch = todo.slice(i, i + B);
      if (emit) emit({ type: 'progress', msg: tr(lang, 'riskCheck', { d: Math.min(done + batch.length, total), n: total }), pct: 99 });
      try {
        const ids = batch.map((r) => r.address).join(',');
        const res = await gpFetch(sol ? `/solana/token_security?contract_addresses=${ids}` : `/token_security/${gp}?contract_addresses=${ids}`);
        const lower = Object.fromEntries(Object.entries(res).map(([k, v]) => [k.toLowerCase(), v]));
        for (const r of batch) {
          const g = res[r.address] || lower[String(r.address).toLowerCase()];
          r.risk = g ? { src: 'goplus', flags: sortFlags(sol ? solFlags(g) : evmFlags(g)), lp: sol ? null : lpLockPct(g) } : { src: 'goplus', flags: [], missing: true };
          if (g) riskCache.set(chain + ':' + r.address, { at: Date.now(), risk: r.risk });
        }
      } catch (e) {
        for (const r of batch) r.risk = { src: null, flags: [], error: true };
        // um só aviso por blockchain (antes repetia-se em cada lote)
        if (emit && !warned.has(chain)) { warned.add(chain); emit({ type: 'warn', msg: tr(lang, 'riskFail', { chain: CHAINS[chain]?.label || chain, err: msgOf(e, lang) }) }); }
        // se o GoPlus continua a recusar depois das esperas, não insiste no resto desta blockchain
        if (e.rateLimited) { for (const r of todo.slice(i + B)) r.risk = { src: null, flags: [], error: true }; done += todo.length - i; break; }
      }
      done += batch.length;
    }
  }
}

// ───────────────────────── Um token pelo endereço (CA) ─────────────────────────
const isEvmAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a);
const isSolAddr = (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);

async function lookupEvm(chainKey, addrRaw, key, versions, local) {
  const chain = CHAINS[chainKey]; const addr = addrRaw.toLowerCase(); const now = todayStart();
  const hist = new Map(); const prices = {}; let meta = null; const srcNames = [];
  let tvl = 0; let hasLiq = false;
  const srcs = chain.sources.filter((s) => versions.has(s.ver));
  const okSrcs = [];
  for (const src0 of srcs) {
    let p, src; try { ({ p, src } = await resolveSrc(key, src0)); } catch (e) { if (e.fatal) throw e; continue; }
    okSrcs.push(src);
    const wantLiq = !!p.tvl;
    const d = await gql(key, src.id, `{ t: token(id: "${addr}") { id symbol name decimals ${p.supply ? 'totalSupply' : ''} ${p.derived ? `d: ${p.derived}` : ''} ${wantLiq ? `tv: ${p.tvl}` : ''} }
      ${p.bundle ? `b: bundles(first:1){ x: ${p.bundle} }` : ''} }`);
    if (wantLiq) hasLiq = true;
    if (!d.t) continue;
    if (wantLiq) tvl += Math.max(0, num(d.t.tv));
    srcNames.push(src.name);
    const dec = Number(d.t.decimals) || 0;
    if (!meta) meta = { symbol: d.t.symbol, name: d.t.name, supply: 0 };
    if (d.t.totalSupply && num(d.t.totalSupply) > 0) meta.supply = Math.max(meta.supply, num(d.t.totalSupply) / Math.pow(10, dec));
    const nativeUsd = num(d.b?.[0]?.x);
    if (p.derived === 'derivedUSD') prices[src.name] = num(d.t.d);
    else if (p.derived && nativeUsd) prices[src.name] = num(d.t.d) * nativeUsd;
    // histórico diário completo (até 4000 dias)
    const fields = `date v: ${p.vol} c: ${p.close} ${p.high ? 'h: ' + p.high : ''}`;
    let rows = []; let before = null;
    for (let i = 0; i < 4; i++) {
      const q = `{ r: tokenDayDatas(first: 1000, orderBy: date, orderDirection: desc, where: { token: "${addr}"${before ? `, date_lt: ${before}` : ''} }) { ${fields} } }`;
      const page = (await gql(key, src.id, q)).r || [];
      rows = rows.concat(page);
      if (page.length < 1000) break;
      before = page[page.length - 1].date;
    }
    mergeHist(hist, addr, rows, src.name);
  }
  if (!meta) return null;
  const days = hist.get(addr) || new Map();
  if (!days.size) return null;
  const best = bestSource(days, prices) || Object.keys(prices)[0];
  const r = computeMetrics(days, prices[best] || 0, now, local);
  if (!r) return null;
  const row = { address: addr, symbol: meta.symbol, name: meta.name, link: chain.explorer + addr, sources: srcNames.join(' + '),
    fdv: meta.supply && r.price ? meta.supply * r.price : null, liquidity: hasLiq ? 2 * tvl * r.price : null,
    ...r, chain: chainKey, chainLabel: chain.label };
  let candles = null;
  for (const src of okSrcs) {
    const p = profiles.get(src.id);
    if (p && p.hour) { candles = (await fetchHourlyEvm(key, { ...src, p }, [addr], 168)).get(addr) || null; break; }
  }
  applyExtras(row, days, candles, ALL_FIELDS_F);
  return row;
}

async function lookupGecko(chainKey, addr, local) {
  const chain = CHAINS[chainKey]; const net = await geckoNetworkId(chain); const now = todayStart();
  const a = isEvmAddr(addr) ? addr.toLowerCase() : addr;
  let info;
  try { info = await gt(`/networks/${net}/tokens/${a}`); } catch (e) { if (/404/.test(e.message)) return null; throw e; }
  const ta = info.data?.attributes; if (!ta) return null;
  const pools = (await gt(`/networks/${net}/tokens/${a}/pools?page=1`)).data || [];
  if (!pools.length) return null;
  // pool principal = maior volume 24h; lançamento = pool mais antiga
  pools.sort((x, y) => num(y.attributes.volume_usd?.h24) - num(x.attributes.volume_usd?.h24));
  const main = pools[0].attributes;
  const created = Math.min(...pools.map((p) => p.attributes.pool_created_at ? Date.parse(p.attributes.pool_created_at) / 1000 : Infinity));
  const baseIsToken = (pools[0].relationships?.base_token?.data?.id || '').toLowerCase().endsWith(a.toLowerCase());
  const d = await gt(`/networks/${net}/pools/${main.address}/ohlcv/day?aggregate=1&limit=1000&currency=usd&token=${baseIsToken ? 'base' : 'quote'}`);
  const days = new Map();
  const olist = d.data?.attributes?.ohlcv_list || [];
  for (const [ts, o, h, l, c, v] of olist) {
    const date = Math.floor(ts / DAY) * DAY; const vol = num(v); const close = num(c);
    let high = 0;
    if (vol >= ATH_MIN_DAY_VOL && close > 0) high = Math.min(num(h), close * ATH_MAX_WICK); else if (vol >= 100) high = close;
    days.set(date, { vol, high, close });
  }
  if (Number.isFinite(created)) { const cd = Math.floor(created / DAY) * DAY; if (!days.size || cd < Math.min(...days.keys())) days.set(cd, { vol: 0, high: 0, close: 0 }); }
  const price = num(ta.price_usd);
  const r = computeMetrics(days, price, now, local); if (!r) return null;
  r.athPartial = geckoPartial(olist, Number.isFinite(created) ? created : null);
  const pc = main.price_change_percentage || {};
  if (baseIsToken) { r.chg1h = pc.h1 != null ? num(pc.h1) : null; r.chg6h = pc.h6 != null ? num(pc.h6) : null; }
  const candles = await geckoHourly(net, main.address, baseIsToken ? 'base' : 'quote');
  const fdv = ta.fdv_usd != null ? num(ta.fdv_usd) : (ta.market_cap_usd != null ? num(ta.market_cap_usd) : null);
  const liquidity = ta.total_reserve_in_usd != null ? num(ta.total_reserve_in_usd) : pools.reduce((acc, p) => acc + num(p.attributes.reserve_in_usd), 0);
  const row = { address: a, symbol: ta.symbol, name: ta.name, sources: 'GeckoTerminal',
    link: chain.explorer ? chain.explorer + a : `https://www.geckoterminal.com/${net}/tokens/${a}`,
    fdv, liquidity, ...r, vol24h: ta.volume_usd?.h24 != null ? num(ta.volume_usd.h24) : r.vol24h, chain: chainKey, chainLabel: chain.label,
    lpLock: main.locked_liquidity_percentage != null ? num(main.locked_liquidity_percentage) : null };
  applyExtras(row, days, candles, ALL_FIELDS_F);
  return row;
}

async function handleToken(req, res) {
  let raw = ''; for await (const c of req) raw += c;
  let body; try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
  const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };
  const addr = String(body.address || '').trim();
  const lang = pickLang(body.lang);
  const key = String(body.apiKey || '').trim() || CONFIG_KEY;
  const other = typeof body.chain === 'string' && OTHER_RE.test(body.chain);
  if (other && !(await ensureChain(body.chain))) return send(400, { error: tr(lang, 'unknownChain') });
  if (!isEvmAddr(addr) && !isSolAddr(addr) && !(other && /^[A-Za-z0-9._:-]{3,120}$/.test(addr))) return send(400, { error: tr(lang, 'badAddr') });
  const lim = rateCheck(req, 'token');
  if (lim) return send(429, { error: tr(lang, 'lookupLimited', lim) });
  // "auto": procura em todas as chains compatíveis com o formato do endereço.
  let keys = body.chain && body.chain !== 'auto' ? [String(body.chain)] : Object.keys(CHAINS).filter((k) => !CHAINS[k].dynamic && !CHAINS[k].others && (k === 'solana') === !isEvmAddr(addr));
  keys = keys.filter((k) => CHAINS[k]);
  if (!keys.length) return send(400, { error: tr(lang, 'unknownChain') });
  if (keys.length === 1 && !other && (keys[0] === 'solana') === isEvmAddr(addr)) return send(400, { error: tr(lang, 'wrongFormat', { chain: CHAINS[keys[0]].label }) });
  if (runningScans >= MAX_SCANS) return send(429, { error: tr(lang, 'busy') });
  runningScans++;
  try {
    const errors = [];
    const results = await Promise.all(keys.map(async (k) => {
      try { return useGecko(k, body.source) ? await lookupGecko(k, addr, parseLocal(body.local)) : await lookupEvm(k, addr, key, parseVersions(body.versions), parseLocal(body.local)); }
      catch (e) { errors.push(`${CHAINS[k].label}: ${msgOf(e, lang)}`); return null; }
    }));
    const rows = results.filter(Boolean);
    if (!rows.length) return send(404, { error: keys.length === 1 ? tr(lang, 'notFound', { chain: CHAINS[keys[0]].label }) : tr(lang, 'notFoundAny'), warnings: errors });
    await addRisk(rows, lang, null);
    await addLpBurn(rows, key);
    send(200, { rows, warnings: errors });
  } catch (e) { send(500, { error: msgOf(e, lang) }); } finally { runningScans--; }
}

// ───────────────────────── Scan + HTTP ─────────────────────────
// Colunas que o servidor sabe calcular. As que a interface esconde não são pedidas.
const ALL_FIELDS = ['risk', 'chain', 'price', 'chg1h', 'chg6h', 'chg12h', 'chg1d', 'chg3d', 'chg7d', 'chg14d', 'chg30d', 'chg90d', 'chg180d', 'chg365d',
  'fdv', 'liq', 'avgVol', 'vol24h', 'age', 'ath', 'athDate', 'pctAth', 'sinceAtl', 'atlDays', 'lhDays', 'llDays', 'sp7', 'sp30', 'sp90', 'sp365'];
function fieldFlags(list, liqFilter) {
  const cols = new Set(Array.isArray(list) ? list.filter((x) => ALL_FIELDS.includes(x)) : ALL_FIELDS);
  const wantHour = ['chg1h', 'chg6h', 'chg12h', 'sp7'].some((k) => cols.has(k));
  return { cols, wantHour, hours: cols.has('sp7') ? 168 : 14, wantLiq: cols.has('liq') || !!liqFilter };
}
const ALL_FIELDS_F = fieldFlags(null, true);

const VERSIONS = ['V2', 'V3', 'V4'];
function parseVersions(v) {
  const set = new Set(Array.isArray(v) ? v.map(String).filter((x) => VERSIONS.includes(x)) : VERSIONS);
  return set.size ? set : new Set(VERSIONS);
}

function parseFilters(b) {
  const n = (x, d) => (x === null || x === undefined || x === '' ? d : Number(x));
  const liqFilter = n(b.liqMin, 0) > 0 || b.liqMax != null;
  const ff = fieldFlags(b.fields, liqFilter);
  const sortKey = SORT_KEYS.includes(b.sortKey) ? b.sortKey : null;
  return {
    ...ff,
    versions: parseVersions(b.versions),
    source: b.source === 'gecko' ? 'gecko' : 'graph',
    gtDex: GT_DEX[b.gtDex] ? b.gtDex : null,
    othersMode: b.othersMode === 'dex' ? 'dex' : 'gas',
    local: { ...parseLocal(b.local), h: ff.cols.has('lhDays') || sortKey === 'lhDays', l: ff.cols.has('llDays') || sortKey === 'llDays' },
    fdvMin: n(b.fdvMin, 0), fdvMax: b.fdvMax == null ? null : Number(b.fdvMax),
    liqMin: n(b.liqMin, 0), liqMax: b.liqMax == null ? null : Number(b.liqMax),
    volMin: n(b.volMin, 0), volMax: b.volMax == null ? null : Number(b.volMax),
    minAge: Math.max(0, Math.floor(n(b.minAge, 0))),
    athMinDays: Math.max(0, Math.floor(n(b.athMinDays, 0))),
    // compatível com o antigo excludeBoring (= stablecoins + nativos)
    exStable: b.exStable != null ? !!b.exStable : b.excludeBoring !== false,
    exNative: b.exNative != null ? !!b.exNative : b.excludeBoring !== false,
    exStocks: !!b.exStocks,
    exRwa: !!b.exRwa,
    vol24Min: n(b.vol24Min, 0), vol24Max: b.vol24Max == null ? null : Number(b.vol24Max),
    // ordenação: qualquer coluna (compatível com o antigo sort 'pct' / 'athDate')
    sortKey: SORT_KEYS.includes(b.sortKey) ? b.sortKey : (b.sort === 'athDate' ? 'athDate' : 'pctAth'),
    sortDir: b.sortDir === 'asc' ? 'asc' : 'desc',
    lang: pickLang(b.lang),
  };
}

function vol24Ok(v, f, slack = 1) {
  if (v == null || !Number.isFinite(v)) return f.vol24Min <= 0 && f.vol24Max == null;
  if (v < f.vol24Min / slack) return false;
  if (f.vol24Max != null && v > f.vol24Max * slack) return false;
  return true;
}
function finalFilter(rows, f) {
  return rows.filter((r) =>
    !excluded(r.cex ? { ...f, exNative: false } : f, r.symbol, r.name, r.price) &&
    fdvOk(r.fdv, f) && (r.cex || liqOk(r.liquidity, f)) &&
    r.avgVol >= f.volMin && (f.volMax == null || r.avgVol <= f.volMax) &&
    vol24Ok(r.vol24h, f) &&
    r.ageDays >= f.minAge &&
    r.daysSinceAth >= f.athMinDays);
}

// Ordenação por qualquer coluna (a interface volta a ordenar com as mesmas regras).
const SORT_KEYS = ['token', 'risk', 'price', 'pctAth', 'sinceAtl', 'atlDays', 'lhDays', 'llDays', 'athDate', 'age', 'avgVol', 'liq', 'chain', 'fdv', 'vol24h', 'ath',
  'chg1h', 'chg6h', 'chg12h', 'chg1d', 'chg3d', 'chg7d', 'chg14d', 'chg30d', 'chg90d', 'chg180d', 'chg365d', 'sp7', 'sp30', 'sp90', 'sp365'];
const RISK_RANK = { crit: 4, high: 3, med: 2, low: 1 };
function sortValue(r, k) {
  switch (k) {
    case 'token': return String(r.symbol || '').toLowerCase();
    case 'chain': return String(r.chainLabel || r.chain || '').toLowerCase();
    case 'risk': return r.risk ? (r.risk.flags && r.risk.flags.length ? Math.max(...r.risk.flags.map((x) => RISK_RANK[x.sev] || 0)) : (r.risk.src ? 0 : null)) : null;
    case 'pctAth': return r.pctOfAth;
    case 'age': return r.ageDays;
    case 'liq': return r.liquidity;
    default:
      if (k.startsWith('sp')) { const a = r[k]; return Array.isArray(a) && a.length > 1 && a[0] > 0 ? (a[a.length - 1] / a[0] - 1) * 100 : null; }
      return r[k];
  }
}
function sortRows(rows, f) {
  const k = f.sortKey || 'pctAth'; const dir = f.sortDir === 'asc' ? 1 : -1;
  return rows.sort((a, b) => {
    const va = sortValue(a, k), vb = sortValue(b, k);
    const na = va == null || (typeof va === 'number' && !Number.isFinite(va)), nb = vb == null || (typeof vb === 'number' && !Number.isFinite(vb));
    if (na !== nb) return na ? 1 : -1;            // vazios sempre no fim
    if (!na && va !== vb) return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * dir;
    return b.pctOfAth - a.pctOfAth;
  });
}
// Pré-seleção dos candidatos (antes do histórico) pela coluna escolhida, quando há aproximação.
function preSort(cands, f, get) {
  const proxy = { fdv: 'fdv', liq: 'liq', price: 'price', avgVol: 'vol', vol24h: 'vol' }[f.sortKey];
  if (!proxy) { cands.sort((a, b) => (get(b).vol || 0) - (get(a).vol || 0)); return; }
  const dir = f.sortDir === 'asc' ? 1 : -1;
  cands.sort((a, b) => {
    const va = get(a)[proxy], vb = get(b)[proxy];
    if ((va == null) !== (vb == null)) return va == null ? 1 : -1;
    return ((va || 0) - (vb || 0)) * dir || (get(b).vol || 0) - (get(a).vol || 0);
  });
}

// ───────────────────────── Site público: limites por visitante e cache ─────────────────────────
// TRUST_PROXY=1 quando a app está atrás do Caddy/Cloudflare (o IP real vem nos cabeçalhos).
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const LIMITS = { scan: Number(process.env.RATE_SCANS_HOUR ?? 0), token: Number(process.env.RATE_LOOKUPS_HOUR ?? 0) }; // 0 = sem limite
const SCAN_CACHE_MS = Number(process.env.SCAN_CACHE_MIN ?? 10) * 60 * 1000;
const hits = new Map();
function clientIp(req) {
  // Atrás do Caddy: X-Forwarded-For é posto pelo Caddy (não confia no que o visitante envia).
  // CF-Connecting-IP só com TRUST_CF=1 (site com o proxy laranja da Cloudflare ligado), senão podia ser forjado.
  if (process.env.TRUST_CF === '1') { const cf = req.headers['cf-connecting-ip']; if (cf) return String(cf).trim(); }
  if (TRUST_PROXY) { const xf = req.headers['x-forwarded-for']; if (xf) return String(xf).split(',').pop().trim(); }
  return req.socket.remoteAddress || '?';
}
function rateCheck(req, kind) {
  const lim = LIMITS[kind]; if (!lim) return null;
  const k = clientIp(req) + '|' + kind; const now = Date.now();
  const arr = (hits.get(k) || []).filter((t) => now - t < 3600e3);
  if (arr.length >= lim) { hits.set(k, arr); return { n: lim, m: Math.max(1, Math.ceil((3600e3 - (now - arr[0])) / 60000)) }; }
  arr.push(now); hits.set(k, arr); return null;
}
// Pesquisa interrompida: devolve a vez ao visitante.
function rateRefund(req, kind) { const a = hits.get(clientIp(req) + '|' + kind); if (a && a.length) a.pop(); }
const CANCELLED = Object.assign(new Error('cancelled'), { cancelled: true });
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.some((t) => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();
const scanCache = new Map();   // pesquisa igual nos últimos minutos → mesmo resultado, sem gastar quota
function scanCacheKey(body, keys) {
  const f = parseFilters(body);
  return JSON.stringify([keys.slice().sort(), f.fdvMin, f.fdvMax, f.liqMin, f.liqMax, f.volMin, f.volMax, f.minAge, f.athMinDays,
    f.exStable, f.exStocks, f.exNative, f.exRwa, f.vol24Min, f.vol24Max, f.source, f.gtDex, keys.includes('others') ? f.othersMode : '', [f.local.hb, f.local.ha, f.local.lb, f.local.la, f.local.h, f.local.l], [...f.versions].sort(), [...f.cols].sort(), f.sortKey, f.sortDir]);
}
setInterval(() => { const now = Date.now(); for (const [k, v] of scanCache) if (now - v.at > SCAN_CACHE_MS) scanCache.delete(k); }, 300e3).unref();

// ───────────────────────── Outras blockchains ─────────────────────────
// Moedas de gas (L1) pelo CoinGecko: lista da categoria "layer-1" (1–2 pedidos) + gráfico diário de 1 ano por candidato.
// O ATH e o ATL vêm do CoinGecko (histórico completo); a liquidez não se aplica (negociadas sobretudo em CEX).
const CG_BASE = process.env.CG_BASE || 'https://api.coingecko.com/api/v3';
const CG_KEY = String(process.env.COINGECKO_API_KEY || '').trim();
const CG_GAP = CG_KEY ? 2200 : 6500;            // chave Demo grátis: 30 pedidos/min; sem chave: ~10/min
const COINS_MAX_CANDIDATES = 30;
let cgLast = 0;
async function cg(pathq) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = cgLast + CG_GAP - Date.now(); if (wait > 0) await sleep(wait);
    cgLast = Date.now();
    const res = await fetch(CG_BASE + pathq, { headers: { accept: 'application/json', ...(CG_KEY ? { 'x-cg-demo-api-key': CG_KEY } : {}) }, signal: AbortSignal.timeout(30000) });
    if (res.status === 429) { await sleep(15000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    return res.json();
  }
  throw new UErr('cgRate');
}
const cgChartCache = new Map();
const dayOf = (iso) => (iso ? Math.floor(Date.parse(iso) / 1000 / DAY) * DAY : null);

async function scanCoins(f, emit) {
  const now = todayStart();
  emit({ type: 'progress', msg: tr(f.lang, 'cgList'), pct: 3 });
  const list = [];
  for (let page = 1; page <= 2; page++) {
    const d = await cg(`/coins/markets?vs_currency=usd&category=layer-1&order=volume_desc&per_page=250&page=${page}&sparkline=true&price_change_percentage=1h,24h,7d,14d,30d,1y`);
    if (!Array.isArray(d) || !d.length) break;
    list.push(...d); if (d.length < 250) break;
  }
  const fx = { ...f, exNative: false };            // aqui as moedas nativas são precisamente o que se procura
  let cands = list.filter((c) => {
    if (!(c.current_price > 0)) return false;
    if (excluded(fx, String(c.symbol || '').toUpperCase(), c.name, c.current_price)) return false;
    if (!fdvOk(c.fully_diluted_valuation || c.market_cap || null, f, 1.05)) return false;
    const v = num(c.total_volume);                  // a média de 7 dias só se sabe com o histórico: aqui só corta extremos
    if (v < f.volMin / 5) return false;
    if (!vol24Ok(v, f, 1.05)) return false;
    if (f.volMax != null && v > f.volMax * 5) return false;
    return true;
  }).map((c) => ({ c, px: { fdv: c.fully_diluted_valuation || c.market_cap || null, liq: null, price: c.current_price, vol: num(c.total_volume) } }));
  preSort(cands, f, (x) => x.px);
  let truncated = false;
  if (cands.length > COINS_MAX_CANDIDATES) { cands = cands.slice(0, COINS_MAX_CANDIDATES); truncated = true; }

  const out = []; let i = 0;
  for (const { c } of cands) {
    i++;
    emit({ type: 'progress', msg: tr(f.lang, 'cgHist', { i, n: cands.length }), pct: 8 + Math.round(88 * i / cands.length) });
    let ch = cgChartCache.get(c.id);
    if (!ch || Date.now() - ch.at > HIST_TTL) {
      try { ch = { at: Date.now(), data: await cg(`/coins/${encodeURIComponent(c.id)}/market_chart?vs_currency=usd&days=365&interval=daily`) }; cgChartCache.set(c.id, ch); }
      catch (e) { if (e.code === 'cgRate') throw e; emit({ type: 'warn', msg: `${c.name}: ${msgOf(e, f.lang)}` }); continue; }
    }
    const vols = new Map((ch.data.total_volumes || []).map(([ms, v]) => [Math.floor(ms / 1000 / DAY) * DAY, num(v)]));
    const days = new Map();
    for (const [ms, p] of ch.data.prices || []) {
      const d = Math.floor(ms / 1000 / DAY) * DAY; const close = num(p); if (!(close > 0)) continue;
      days.set(d, { vol: vols.get(d) || 0, high: close, close });
    }
    if (!days.size) continue;
    const athD = dayOf(c.ath_date); const atlD = dayOf(c.atl_date);
    const created = Math.min(...days.keys(), ...(athD ? [athD] : []), ...(atlD ? [atlD] : []));
    if (!days.has(created)) days.set(created, { vol: 0, high: 0, close: 0 });
    const r = computeMetrics(days, c.current_price, now, f.local); if (!r) continue;
    // ATH e ATL do CoinGecko (histórico completo; o gráfico grátis só tem 1 ano)
    if (c.ath > 0) {
      r.ath = Math.max(num(c.ath), r.price); r.athDate = r.price >= num(c.ath) ? now : (athD ?? r.athDate);
      r.daysSinceAth = Math.max(0, Math.floor((now - r.athDate) / DAY)); r.pctOfAth = (r.price / r.ath) * 100;
    }
    if (c.atl > 0) {
      r.atl = Math.min(num(c.atl), r.price); r.atlDate = r.price <= num(c.atl) ? now : (atlD ?? r.atlDate);
      r.atlDays = Math.max(0, Math.floor((now - r.atlDate) / DAY)); r.sinceAtl = (r.price / r.atl - 1) * 100;
    }
    const pc = (k) => { const v = c[`price_change_percentage_${k}_in_currency`]; return v == null ? null : num(v); };
    const row = { address: c.id, symbol: String(c.symbol || '').toUpperCase(), name: c.name, link: `https://www.coingecko.com/en/coins/${c.id}`,
      sources: 'CoinGecko', fdv: c.fully_diluted_valuation || c.market_cap || null, liquidity: null, cex: true, ...r,
      vol24h: num(c.total_volume), chain: 'others', chainLabel: c.name };
    for (const [k, v] of [['chg1d', '24h'], ['chg7d', '7d'], ['chg14d', '14d'], ['chg30d', '30d'], ['chg365d', '1y']]) if (pc(v) != null) row[k] = pc(v);
    // velas horárias da última semana = sparkline do CoinGecko (para 1h/6h/12h e o gráfico de 1 semana)
    const sp = c.sparkline_in_7d?.price || []; const nowSec = Math.floor(Date.now() / 1000);
    const candles = sp.map((p, k) => ({ t: nowSec - (sp.length - 1 - k) * 3600, o: null, c: num(p) })).filter((x) => x.c > 0);
    applyExtras(row, days, candles, f);
    if (pc('1h') != null) row.chg1h = pc('1h');
    hide(row, '_days', days);
    out.push(row);
  }
  return { rows: finalFilter(out, f), scanned: list.length, truncated };
}

// Redes com DEX para "Outras blockchains + tokens das DEX" (GeckoTerminal; nomes como aparecem na lista de redes).
const OTHER_NETS = [/^avalanche$/i, /^internet computer/i, /kasplex|^kaspa/i, /^sui( network)?$/i, /^ton$/i, /^tron$/i, /^aptos$/i,
  /^sonic$/i, /hyperevm|^hyperliquid/i, /^berachain/i, /^cardano$/i, /^near( protocol)?$/i, /^sei( evm| network)?$/i, /^cronos$/i];
async function otherNetKeys() {
  const nets = await loadGtNetworks(); const keys = [];
  for (const re of OTHER_NETS) {
    const n = nets.find((x) => re.test(x.name) && !/test/i.test(x.name));
    if (n && await ensureChain('gt:' + n.id)) keys.push('gt:' + n.id);
  }
  return keys;
}

async function handleScan(req, res) {
  let raw = ''; for await (const c of req) raw += c;
  let body; try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache' });
  // Botão "Parar": o browser fecha a ligação → a pesquisa pára no próximo passo (não gasta mais quota nem ocupa o lugar).
  let aborted = false;
  res.on('close', () => { if (!res.writableFinished) aborted = true; });
  const warnLog = [];   // avisos desta pesquisa, guardados com o resultado na cache (para os voltar a mostrar)
  const emit = (o) => { if (aborted) throw CANCELLED; if (o.type === 'warn') warnLog.push(o); res.write(JSON.stringify(o) + '\n'); };
  let keys = Array.isArray(body.chains) ? body.chains : [body.chain || 'ethereum'];
  keys = [...new Set(keys.map(String))].slice(0, 30);
  for (const k of keys) if (!CHAINS[k] && OTHER_RE.test(k)) await ensureChain(k);
  keys = keys.filter((k) => CHAINS[k]);
  const ownKey = !!String(body.apiKey || '').trim();
  const cKey = keys.length && !ownKey && SCAN_CACHE_MS > 0 ? scanCacheKey(body, keys) : null;
  const hit = cKey && scanCache.get(cKey);
  if (hit && Date.now() - hit.at < SCAN_CACHE_MS) {
    emit({ type: 'progress', msg: '…', pct: 100 });
    for (const w of hit.warns || []) emit(w);
    emit({ ...hit.result, cachedMin: Math.floor((Date.now() - hit.at) / 60000) }); return res.end();
  }
  const lim = rateCheck(req, 'scan');
  if (lim) { emit({ type: 'error', msg: tr(pickLang(body.lang), 'rateLimited', lim) }); return res.end(); }
  if (runningScans >= MAX_SCANS) { emit({ type: 'error', msg: tr(pickLang(body.lang), 'busy') }); return res.end(); }
  runningScans++;
  try {
    if (!keys.length) throw new UErr('pickChain');
    const f = parseFilters(body);
    const key = String(body.apiKey || '').trim() || CONFIG_KEY;

    // Progresso global = média do progresso de cada chain; mensagens com o nome da chain.
    const pct = Object.fromEntries(keys.map((k) => [k, 0]));
    const emitFor = (k) => (o) => {
      const label = CHAINS[k].label;
      if (o.type === 'progress') {
        if (o.pct != null) pct[k] = Math.max(pct[k], Math.min(100, o.pct));
        const total = Object.values(pct).reduce((a, b) => a + b, 0) / keys.length;
        emit({ type: 'progress', msg: `${label}: ${o.msg}`, pct: Math.round(total) });
      } else emit({ ...o, chain: k, msg: `${label}: ${o.msg}` });
    };

    const srcMode = f.gtDex ? 'gecko' : f.source;     // V4 pelo GeckoTerminal: chains Uniswap vão todas ao GeckoTerminal
    const wantOthers = keys.includes('others');
    const extraNets = wantOthers && f.othersMode === 'dex' ? await otherNetKeys() : [];
    for (const k of extraNets) pct[k] = 0;
    const baseKeys = keys.filter((k) => k !== 'others');
    const evmKeys = baseKeys.filter((k) => !useGecko(k, srcMode));
    const geckoKeys = baseKeys.filter((k) => useGecko(k, srcMode));
    // Com várias chains GeckoTerminal, cada uma recebe menos pedidos (limite partilhado de 30/min).
    const budget = geckoKeys.length > 1 ? { pages: 4, newPages: 2, cands: 20 } : { pages: 10, newPages: 5, cands: GECKO_MAX_CANDIDATES };

    const all = []; let scanned = 0; let truncated = false; let ok = 0; let fatal = null;
    const take = (k, r) => { ok++; scanned += r.scanned ?? r.rows.length; truncated = truncated || r.truncated;
      // Object.assign (e não {...row}) para manter os campos internos escondidos (ex. _pool, usado na verificação das LP)
      for (const row of r.rows) all.push(row.cex ? row : Object.assign(row, { chain: k, chainLabel: CHAINS[k].label })); pct[k] = 100; };
    const fail = (k, e) => { if (e && e.cancelled) throw e; pct[k] = 100; if (e.fatal) fatal = e; emitFor(k)({ type: 'warn', msg: e.fatal ? tr(f.lang, 'keyRejected', { err: e.message }) : msgOf(e, f.lang) }); };

    const evmJob = Promise.all(evmKeys.map(async (k) => {
      if (!key) return fail(k, new UErr('noKey'));
      try { take(k, await scanEvm(k, f, key, emitFor(k))); } catch (e) { fail(k, e); }
    }));
    const geckoJob = (async () => {
      for (const k of geckoKeys) {
        try { take(k, await scanGecko(k, f, emitFor(k), budget)); } catch (e) { fail(k, e); }
      }
      // tokens das DEX das outras redes: poucas páginas e candidatos por rede (o limite de 30 pedidos/min é partilhado)
      for (const k of extraNets) {
        try { take(k, await scanGecko(k, f, emitFor(k), { pages: 1, newPages: 0, cands: 5 })); }
        catch (e) { if (e && e.cancelled) throw e; pct[k] = 100; }       // rede sem pools/dados: ignora em silêncio
      }
    })();
    // moedas de gas (CoinGecko, limite próprio): em paralelo com o resto
    const coinsJob = wantOthers ? (async () => {
      try { take('others', await scanCoins(f, emitFor('others'))); } catch (e) { fail('others', e); }
    })() : null;
    await Promise.all([evmJob, geckoJob, coinsJob].filter(Boolean));

    if (!ok) throw (fatal ? Object.assign(new Error(fatal.message), { fatal: true }) : new UErr('noneResponded'));
    const rows = finalFilter(all, f);
    // o GoPlus também dá a % de LP queimada/bloqueada (gráfico da coluna de liquidez)
    if ((f.cols.has('risk') || f.cols.has('liq')) && rows.length) await addRisk(rows, f.lang, emit);
    if (f.cols.has('liq') && rows.length) { emit({ type: 'progress', msg: tr(f.lang, 'lpCheck'), pct: 99 }); await addLpBurn(rows, key); }
    sortRows(rows, f);                                    // depois do risco, para se poder ordenar por ele
    const result = { type: 'result', chains: keys, scanned, truncated, rows };
    // não guarda na cache se a verificação de risco falhou (para a próxima pesquisa voltar a tentar)
    if (cKey && !result.rows.some((r) => r.risk && r.risk.error)) scanCache.set(cKey, { at: Date.now(), result, warns: warnLog });
    emit(result);
  } catch (e) {
    if (e && e.cancelled) { rateRefund(req, 'scan'); console.log('Pesquisa interrompida pelo utilizador'); }
    else { const L = pickLang(body.lang); try { emit({ type: 'error', msg: e.fatal ? tr(L, 'keyRejected', { err: e.message }) : msgOf(e, L) }); } catch (_) {} }
  } finally { runningScans--; }
  res.end();
}

// Caminho base (ex.: BASE_PATH=/screener para servir em https://dominio/screener/). Vazio = raiz.
const BASE_PATH = String(process.env.BASE_PATH || '').replace(/\/+$/, '');

const server = http.createServer(async (req, res) => {
  try {
    if (BASE_PATH) {
      const u = req.url.split('?')[0];
      if (u === BASE_PATH || u === '/') {            // /screener → /screener/ (os caminhos da página são relativos)
        res.writeHead(301, { location: BASE_PATH + '/' }); return res.end();
      }
      if (!req.url.startsWith(BASE_PATH + '/')) { res.writeHead(404); return res.end('not found'); }
      req.url = req.url.slice(BASE_PATH.length) || '/';
    }
    if (!authorized(req)) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="TopCat Screener", charset="UTF-8"', 'content-type': 'text/plain; charset=utf-8' });
      return res.end(tr('en', 'pass'));
    }
    if (req.method === 'POST' && req.url === '/api/scan') return await handleScan(req, res);
    if (req.method === 'POST' && req.url === '/api/token') return await handleToken(req, res);
    if (req.method === 'GET' && req.url === '/api/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ hasKey: !!CONFIG_KEY, chains: Object.fromEntries(Object.entries(CHAINS).filter(([, c]) => !c.dynamic).map(([k, c]) => [k, c.others
        ? { label: c.label, sources: ['CoinGecko'], versions: [], others: true }
        : { label: c.label, sources: c.gecko ? ['GeckoTerminal'] : c.sources.map((s) => s.name), versions: c.gecko ? [] : c.sources.map((s) => s.ver), gt: !!c.gtNet }])) }));
    }
    if (req.method === 'GET' && req.url === '/api/networks') {
      const list = await loadGtNetworks();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' });
      return res.end(JSON.stringify({ networks: list }));
    }
    const asset = req.url.split('?')[0];
    if (req.method === 'GET' && asset === '/i18n.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'i18n.js')));
    }
    if (req.method === 'GET' && (asset === '/logo.png' || asset === '/apple-touch-icon.png')) {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', asset.slice(1))));
    }
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    }
    res.writeHead(404); res.end('not found');
  } catch (e) { try { res.writeHead(500); res.end(String(e.message)); } catch (_) {} }
});

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`TopCat Screener a correr em http://localhost:${PORT}`);
    console.log(CONFIG_KEY ? 'Chave da The Graph: carregada' : 'Chave da The Graph: não definida (podes colá-la na interface)');
    console.log(ACCESS_PASSWORD ? 'Palavra-passe de acesso: ativa' : 'Palavra-passe de acesso: desligada (site público)');
    if (BASE_PATH) console.log('Caminho base:', BASE_PATH + '/');
    console.log('Limites por visitante/hora:', LIMITS.scan || 'sem limite', 'pesquisas,', LIMITS.token || 'sem limite', 'consultas · cache', SCAN_CACHE_MS / 60000, 'min');
  });
}
module.exports = { computeMetrics, mergeHist, finalFilter, sortRows, parseFilters, server };
