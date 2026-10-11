import express from 'express';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { registerComplianceRoutes } from './server/compliance.ts';
import {
  createRateLimiter,
  csrfProtection,
  genericErrorHandler,
  requireHttps,
  requestOriginGuard,
  securityHeaders
} from './server/security.ts';

// Resolve the current module's directory in a way that works in BOTH:
//  - ESM (dev: `node server.ts` / tsx) where we derive it from import.meta.url
//  - CommonJS (the esbuild bundle consumed by Electron) where __dirname exists
//    natively and import.meta is empty.
declare const __dirname: string | undefined;

const __filename: string =
  typeof __dirname === 'string'
    ? path.join(__dirname, 'server.ts')
    : fileURLToPath(import.meta.url);
const moduleDir: string = typeof __dirname === 'string' ? __dirname : path.dirname(__filename);

const app = express();
app.disable('x-powered-by');
const trustProxyHops = process.env.TRUST_PROXY_HOPS;
if (trustProxyHops !== undefined) {
  const hops = Number(trustProxyHops);
  if (!Number.isInteger(hops) || hops < 1 || hops > 3) {
    throw new Error('TRUST_PROXY_HOPS must be an integer from 1 to 3');
  }
  app.set('trust proxy', hops);
}
// Allow PORT=0 to request an OS-assigned ephemeral port (used by the desktop
// app to avoid conflicts). Invalid values fail during startup.
const configuredPort = process.env.PORT;
const PORT = configuredPort !== undefined && configuredPort !== '' ? Number(configuredPort) : 3000;
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  throw new Error('PORT must be an integer from 0 to 65535');
}

app.use(securityHeaders);
app.use(requireHttps);
app.use(requestOriginGuard);
app.use(csrfProtection);
app.use('/api', createRateLimiter({ windowMs: 60_000, max: 180 }));
app.use('/api/auth', createRateLimiter({ windowMs: 15 * 60_000, max: 12 }));
app.use('/api/compliance', createRateLimiter({ windowMs: 60_000, max: 20 }));
app.use(express.json({ limit: '64kb', strict: true }));
app.use(express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 50 }));
registerComplianceRoutes(app);

// In-memory quote cache with 3.5s TTL
interface CachedQuote {
  price: number;
  prevClose: number;
  change: number;
  changePercent: number;
  high: number;
  low: number;
  volume?: string | number;
  currency?: string;
  updatedAt: number;
  marketTime?: number;
}

function isValidSymbol(symbol: string): boolean {
  return symbol.length > 0 && symbol.length <= 32
    && /^[A-Za-z0-9^=._/ -]+$/.test(symbol)
    && !symbol.includes('..')
    && symbol.trim() === symbol;
}

const CHART_INTERVALS = new Set(['1m', '2m', '5m', '15m', '30m', '60m', '90m', '1h', '1d', '5d', '1wk', '1mo', '3mo']);
const CHART_RANGES = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max']);

const quoteCache = new Map<string, CachedQuote>();
const CACHE_TTL_MS = 3500;
const instrumentSearchCache = new Map<string, { expiresAt: number; instruments: GlobalInstrumentSearchResult[] }>();
const INSTRUMENT_SEARCH_TTL_MS = 30_000;

interface GlobalInstrumentSearchResult {
  symbol: string;
  name: string;
  exchange: string;
  type: string;
  quoteType: string;
}

const YAHOO_FINANCE_REGIONS = new Set([
  'AR', 'AT', 'AU', 'BH', 'BE', 'BR', 'CA', 'CL', 'CN', 'CO', 'CZ', 'DK', 'EG', 'EE',
  'FI', 'FR', 'DE', 'GR', 'HK', 'HU', 'IS', 'IN', 'ID', 'IE', 'IL', 'IT', 'JP', 'JO',
  'KW', 'LV', 'LT', 'MY', 'MX', 'NL', 'NZ', 'NO', 'OM', 'PK', 'PE', 'PH', 'PL', 'PT',
  'QA', 'RO', 'RU', 'SA', 'SG', 'ZA', 'KR', 'ES', 'SE', 'CH', 'TW', 'TH', 'TR', 'AE',
  'GB', 'US', 'VE', 'VN'
]);

// Symbol translation mapping for Yahoo Finance
const SYMBOL_MAP: Record<string, string> = {
  'NVDA US': 'NVDA',
  'AAPL US': 'AAPL',
  'MSFT US': 'MSFT',
  'AMZN US': 'AMZN',
  'GOOGL US': 'GOOGL',
  'META US': 'META',
  'TSLA US': 'TSLA',
  'AVGO US': 'AVGO',
  'BRK/B US': 'BRK-B',
  'JPM US': 'JPM',
  'V US': 'V',
  'WMT US': 'WMT',
  'PG US': 'PG',
  'XOM US': 'XOM',
  'JNJ US': 'JNJ',
  'LLY US': 'LLY',
  'UNH US': 'UNH',
  'MA US': 'MA',
  'HD US': 'HD',
  'COST US': 'COST',
  'SPY US': 'SPY',
  'QQQ US': 'QQQ',
  'IWM US': 'IWM',
  'DIA US': 'DIA',
  'VOO US': 'VOO',
  'XLK US': 'XLK',
  'XLF US': 'XLF',
  'XLE US': 'XLE',
  'XLV US': 'XLV',
  'GLD US': 'GLD',
  'SLV US': 'SLV',
  'USO US': 'USO',
  'TLT US': 'TLT',
  'HYG US': 'HYG',
  'LQD US': 'LQD',
  'BND US': 'BND',
  'XAU/USD': 'GC=F',
  'XAG/USD': 'SI=F',
  'WTI CRUDE': 'CL=F',
  'BRENT CRUDE': 'BZ=F',
  'NATGAS HH': 'NG=F',
  'COPPER HG': 'HG=F',
  'US 10Y BENCH': '^TNX',
  'US 2Y BENCH': '^IRX',
  'US 30Y BENCH': '^TYX',
  'VIX SPOT': '^VIX',
  'EUR/USD': 'EURUSD=X',
  'USD/JPY': 'JPY=X',
  'GBP/USD': 'GBPUSD=X',
  'USD/CHF': 'CHF=X',
  'AUD/USD': 'AUDUSD=X',
  'USD/CAD': 'CAD=X',
  'NZD/USD': 'NZDUSD=X',
  'USD/CNH': 'CNH=X',
  'BTC/USD': 'BTC-USD',
  'ETH/USD': 'ETH-USD',
  'SOL/USD': 'SOL-USD',
  'XRP/USD': 'XRP-USD',
  'BNB/USD': 'BNB-USD',
  'DOGE/USD': 'DOGE-USD'
};

// Helper: fetch single symbol from Yahoo Finance Chart API
async function fetchYahooQuote(rawSymbol: string): Promise<CachedQuote | null> {
  if (!isValidSymbol(rawSymbol)) return null;
  const yahooSymbol = SYMBOL_MAP[rawSymbol] || rawSymbol.replace(' US', '');
  const now = Date.now();

  const cached = quoteCache.get(yahooSymbol);
  if (cached && (now - cached.updatedAt) < CACHE_TTL_MS) {
    return cached;
  }

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=1d`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      signal: AbortSignal.timeout(4000)
    });

    if (!res.ok) {
      if (cached) return cached;
      return null;
    }

    const data = (await res.json()) as any;
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta || typeof meta.regularMarketPrice !== 'number') {
      if (cached) return cached;
      return null;
    }

    const price = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose || meta.previousClose || price;
    const change = Number((price - prevClose).toFixed(4));
    const changePercent = prevClose > 0 ? Number(((change / prevClose) * 100).toFixed(2)) : 0;
    const high = meta.regularMarketDayHigh || price;
    const low = meta.regularMarketDayLow || price;
    const volume = meta.regularMarketVolume;
    const currency = meta.currency || 'USD';

    const quote: CachedQuote = {
      price,
      prevClose,
      change,
      changePercent,
      high,
      low,
      volume,
      currency,
      updatedAt: now,
      marketTime: typeof meta.regularMarketTime === 'number'
        ? meta.regularMarketTime * 1000
        : undefined
    };

    quoteCache.set(yahooSymbol, quote);
    if (quoteCache.size > 1000) {
      const oldest = quoteCache.keys().next().value;
      if (oldest !== undefined) quoteCache.delete(oldest);
    }
    return quote;
  } catch {
    if (cached) return cached;
    return null;
  }
}

// REST API Endpoints

// 1. Health check & latency verification
app.get('/api/market-data/health', (_req, res) => {
  res.json({
    status: 'ONLINE',
    provider: 'HYBRID_REALTIME_ENGINE',
    sources: ['Yahoo Finance quotes and instrument search', 'Binance WebSocket Sub-Second', 'Open ER API / ECB FX'],
    cachedSymbolsCount: quoteCache.size,
    timestamp: new Date().toISOString()
  });
});

// Search public provider-indexed instruments. The result set is not a licensed
// or complete security master, and quote availability varies by listing.
app.get('/api/market-data/search', async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const regionParameter = req.query.region;
  const region = typeof regionParameter === 'string' ? regionParameter.toUpperCase() : 'US';
  if (query.length < 2 || query.length > 80 || /[\u0000-\u001f\u007f]/.test(query)) {
    return res.status(400).json({ error: 'Search text must contain 2 to 80 characters.' });
  }
  if (regionParameter !== undefined && typeof regionParameter !== 'string') {
    return res.status(400).json({ error: 'A single provider region is required.' });
  }
  if (!YAHOO_FINANCE_REGIONS.has(region)) {
    return res.status(400).json({ error: 'Unsupported provider region.' });
  }

  const cacheKey = `${region}:${query.toLowerCase()}`;
  const now = Date.now();
  const cached = instrumentSearchCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    res.setHeader('Cache-Control', 'private, max-age=30');
    return res.json({
      success: true,
      provider: 'Yahoo Finance Search',
      region,
      cached: true,
      instruments: cached.instruments
    });
  }

  try {
    const params = new URLSearchParams({
      q: query,
      quotesCount: '20',
      newsCount: '0',
      listsCount: '0',
      lang: 'en-US',
      region
    });
    const response = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?${params}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
      },
      signal: AbortSignal.timeout(7000)
    });
    if (!response.ok) {
      return res.status(502).json({ error: `Instrument search provider returned HTTP ${response.status}.` });
    }

    const payload = await response.json() as {
      quotes?: Array<{
        symbol?: string;
        shortname?: string;
        longname?: string;
        exchange?: string;
        exchDisp?: string;
        typeDisp?: string;
        quoteType?: string;
      }>;
    };
    const instruments = (Array.isArray(payload.quotes) ? payload.quotes : [])
      .filter((item): item is typeof item & { symbol: string } => typeof item.symbol === 'string'
        && isValidSymbol(item.symbol))
      .map(item => ({
        symbol: item.symbol,
        name: (item.longname || item.shortname || item.symbol).slice(0, 160),
        exchange: (item.exchDisp || item.exchange || 'Exchange not reported').slice(0, 80),
        type: (item.typeDisp || item.quoteType || 'Other').slice(0, 80),
        quoteType: (item.quoteType || 'UNKNOWN').slice(0, 32)
      }));

    if (instrumentSearchCache.size > 500) {
      const oldest = instrumentSearchCache.keys().next().value;
      if (oldest !== undefined) instrumentSearchCache.delete(oldest);
    }
    instrumentSearchCache.set(cacheKey, {
      expiresAt: now + INSTRUMENT_SEARCH_TTL_MS,
      instruments
    });
    res.setHeader('Cache-Control', 'private, max-age=30');
    return res.json({
      success: true,
      provider: 'Yahoo Finance Search',
      region,
      cached: false,
      instruments
    });
  } catch (error) {
    const message = error instanceof Error && error.name === 'TimeoutError'
      ? 'Instrument search provider timed out.'
      : 'Instrument search provider is unavailable.';
    return res.status(502).json({ error: message });
  }
});

// 2. Batch quotes endpoint
app.get('/api/market-data/quotes', async (req, res) => {
  const symbolsParam = req.query.symbols;
  if (symbolsParam !== undefined && typeof symbolsParam !== 'string') {
    return res.status(400).json({ error: 'A single comma-separated symbols value is required.' });
  }
  const rawSymbols = symbolsParam === undefined
    ? Object.keys(SYMBOL_MAP)
    : symbolsParam.split(',').map(s => s.trim()).filter(Boolean);
  if (rawSymbols.length > 50 || rawSymbols.some(symbol => !isValidSymbol(symbol))) {
    return res.status(400).json({ error: 'Provide no more than 50 valid instrument symbols.' });
  }

  // Run in chunks to prevent socket starvation
  const results: Record<string, CachedQuote> = {};
  const chunkSize = 15;
  
  for (let i = 0; i < rawSymbols.length; i += chunkSize) {
    const chunk = rawSymbols.slice(i, i + chunkSize);
    await Promise.all(
      chunk.map(async (rawSym) => {
        const quote = await fetchYahooQuote(rawSym);
        if (quote) {
          results[rawSym] = quote;
        }
      })
    );
  }

  res.setHeader('Cache-Control', 'public, max-age=2');
  res.json({
    success: true,
    timestamp: Date.now(),
    quotes: results
  });
});

// 3. Single quote endpoint with intraday sparkline
app.get('/api/market-data/chart/:symbol', async (req, res) => {
  const rawSymbol = req.params.symbol;
  if (!isValidSymbol(rawSymbol)) {
    return res.status(400).json({ error: 'A valid instrument symbol is required.' });
  }
  const yahooSymbol = SYMBOL_MAP[rawSymbol] || rawSymbol.replace(' US', '');
  if ((req.query.interval !== undefined && typeof req.query.interval !== 'string')
    || (req.query.range !== undefined && typeof req.query.range !== 'string')) {
    return res.status(400).json({ error: 'A single chart interval and range are required.' });
  }
  const interval = typeof req.query.interval === 'string' ? req.query.interval : '5m';
  const range = typeof req.query.range === 'string' ? req.query.range : '1d';
  if (!CHART_INTERVALS.has(interval) || !CHART_RANGES.has(range)) {
    return res.status(400).json({ error: 'The requested chart interval or range is not supported.' });
  }

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${interval}&range=${range}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      return res.status(502).json({ error: 'Market chart provider is unavailable.' });
    }

    const data = (await response.json()) as any;
    const result = data?.chart?.result?.[0];
    if (!result) {
      return res.status(404).json({ error: 'No chart data found' });
    }

    const timestamps = result.timestamp || [];
    const quotes = result.indicators?.quote?.[0] || {};
    const opens = quotes.open || [];
    const highs = quotes.high || [];
    const lows = quotes.low || [];
    const closes = quotes.close || [];
    const volumes = quotes.volume || [];

    const candles = timestamps.map((ts: number, i: number) => ({
      time: ts,
      open: opens[i],
      high: highs[i],
      low: lows[i],
      close: closes[i],
      volume: volumes[i]
    })).filter((c: any) => typeof c.close === 'number');

    res.json({
      symbol: rawSymbol,
      yahooSymbol,
      meta: result.meta,
      candles
    });
  } catch {
    res.status(502).json({ error: 'Market chart provider is unavailable.' });
  }
});

// 4. FX Rates from Open ER API / ECB
app.get('/api/market-data/fx', async (_req, res) => {
  try {
    const response = await fetch('https://open.er-api.com/v6/latest/USD', {
      signal: AbortSignal.timeout(4000)
    });
    if (!response.ok) throw new Error('FX upstream response error');
    const data = await response.json();
    res.json(data);
  } catch {
    res.status(502).json({ error: 'Foreign-exchange data provider is unavailable.' });
  }
});

// Resolve the directory containing the built frontend (dist).
// Defaults to <serverDir>/dist but can be overridden via STATIC_DIR for
// packaged desktop builds where the assets live elsewhere.
function resolveStaticDir(): string {
  const configured = process.env.STATIC_DIR;
  if (configured) return path.resolve(configured);
  return path.resolve(moduleDir, 'dist');
}

// Boots the Express app. Returns the underlying http.Server so the caller
// (e.g. the Electron main process) can read the actual bound port and shut
// it down cleanly.
export async function startServer(): Promise<import('http').Server> {
  // In desktop/packaged mode we always serve the pre-built static assets.
  // In dev mode we mount Vite as middleware for HMR.
  if (process.env.NODE_ENV === 'production' || process.env.STATIC_DIR) {
    const distDir = resolveStaticDir();
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    // Lazy import so Vite is only loaded in development.
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  }

  const host = process.env.HOST || '127.0.0.1';
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1']);
  if (!loopbackHosts.has(host) && process.env.ALLOW_PUBLIC_BIND !== 'true') {
    throw new Error('Non-loopback binding requires ALLOW_PUBLIC_BIND=true');
  }
  if (!loopbackHosts.has(host)) {
    let publicUrl: URL | undefined;
    try {
      publicUrl = new URL(process.env.PUBLIC_APP_URL ?? '');
    } catch {
      throw new Error('Public binding requires a valid HTTPS PUBLIC_APP_URL');
    }
    if (process.env.PUBLIC_HTTPS !== 'true' || !process.env.TRUST_PROXY_HOPS
      || publicUrl.protocol !== 'https:') {
      throw new Error('Public binding requires PUBLIC_HTTPS=true, HTTPS PUBLIC_APP_URL, and TRUST_PROXY_HOPS');
    }
  }

  return new Promise((resolve, reject) => {
    const server = app.listen(PORT, host, () => {
      server.headersTimeout = 10_000;
      server.requestTimeout = 30_000;
      server.keepAliveTimeout = 5_000;
      app.use(genericErrorHandler);
      const address = server.address();
      const boundPort = typeof address === 'object' && address ? address.port : PORT;
      console.log(`[Finerd Terminal] Server listening on ${host}:${boundPort}`);
      resolve(server);
    });
    server.once('error', reject);
  });
}

export { app };

// Only auto-start when this file is executed directly (npm start / bun / node).
// When imported by the Electron main process we let it control the lifecycle.
const isMainModule = (() => {
  // In the esbuild CJS bundle, import.meta.url is empty, so rely on the
  // CommonJS `require.main === module` idiom to detect direct execution.
  if (typeof require === 'function' && typeof module === 'object') {
    return require.main === module;
  }
  try {
    return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  startServer().catch((err) => {
    console.error('Fatal server startup error:', err);
    process.exit(1);
  });
}
