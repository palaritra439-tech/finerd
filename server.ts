import express from 'express';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { WebSocketServer } from 'ws';
import { registerComplianceRoutes } from './server/compliance.ts';
import {
  createRateLimiter,
  csrfProtection,
  genericErrorHandler,
  requireHttps,
  requestOriginGuard,
  securityHeaders
} from './server/security.ts';
import { INITIAL_INSTRUMENTS } from './src/data/mockData.ts';
import { COMPREHENSIVE_FINANCIAL_NEWS } from './src/data/financialNewsData.ts';
import { WORLD_MONITOR_EVENTS } from './src/data/worldMonitorData.ts';
import { buildFinancialInstrumentCatalog } from './src/services/financialInstrumentCatalog.ts';
import { linkEventsToAssets } from './src/services/terminalFeatures.ts';

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

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

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
app.use('/api/analyst', createRateLimiter({ windowMs: 60_000, max: 15 }));
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

function normalizeSecTicker(ticker: string): string {
  return ticker.trim().toUpperCase().replace(/\s+US$/, '');
}

function normalizeIssuerName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function extractFilingReferences(html: string, expression: RegExp): string[] {
  const text = html
    .replace(/<(script|style|ix:header)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?(?:p|div|li|tr|td|th|h[1-6]|br)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, value: string) => {
      const codePoint = Number(value);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : ' ';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, value: string) => {
      const codePoint = parseInt(value, 16);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : ' ';
    })
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n');
  const sentences = text.split(/(?<=[.!?])\s+|\n+/);
  const references: string[] = [];
  const seen = new Set<string>();

  for (const sentence of sentences) {
    const excerpt = sentence.trim();
    if (excerpt.length < 35 || excerpt.length > 1200 || !expression.test(excerpt)) continue;
    expression.lastIndex = 0;
    if (!/\b(?:accounted for|represented|comprised|purchased|sold|manufactured|supplied|provided|contracted|included|include|named|identified)\b|\b(?:was|were|is|are)\s+(?:a|an|the)\s+(?:customer|client|supplier|vendor)\b|\b(?:customer|client|supplier|vendor)s?\s+(?:was|were|is|are|of|for|from|with|to|include|included|accounted)\b/i.test(excerpt)) continue;
    const key = excerpt.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    references.push(excerpt.slice(0, 900));
    if (references.length >= 8) break;
  }
  return references;
}

const CHART_INTERVALS = new Set(['1m', '2m', '5m', '15m', '30m', '60m', '90m', '1h', '1d', '5d', '1wk', '1mo', '3mo']);
const CHART_RANGES = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max']);

const quoteCache = new Map<string, CachedQuote>();
const CACHE_TTL_MS = 3500;
const terminalWebSocketServer = new WebSocketServer({ noServer: true, maxPayload: 1024 });
const instrumentSearchCache = new Map<string, { expiresAt: number; instruments: GlobalInstrumentSearchResult[] }>();
const INSTRUMENT_SEARCH_TTL_MS = 30_000;
let secIssuerIndexCache: { expiresAt: number; issuers: SecIssuer[] } | null = null;
const secAnnualFilingCache = new Map<string, { expiresAt: number; result: SecAnnualFilingResult }>();
const SEC_CACHE_TTL_MS = 15 * 60_000;
const SEC_INDEX_CACHE_TTL_MS = 6 * 60 * 60_000;
const SEC_FILING_MAX_BYTES = 15 * 1024 * 1024;

interface SecIssuer {
  cik_str: number;
  ticker: string;
  title: string;
}

interface SecAnnualFilingResult {
  filing: { form: string; filingDate: string; url: string } | null;
  supplierReferences: string[];
  customerReferences: string[];
}

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

const terminalInstrumentCatalog = buildFinancialInstrumentCatalog(INITIAL_INSTRUMENTS);
const linkedTerminalEvents = linkEventsToAssets(WORLD_MONITOR_EVENTS, terminalInstrumentCatalog);

app.get('/api/terminal/v1/instruments', (req, res) => {
    const limit = Number(req.query.limit ?? 100);
    const offset = Number(req.query.offset ?? 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500
      || !Number.isInteger(offset) || offset < 0 || offset > 100_000) {
      return res.status(400).json({ error: 'Provide an integer limit from 1 to 500 and a non-negative offset.' });
    }
    const query = typeof req.query.q === 'string' ? req.query.q.trim().toLocaleLowerCase() : '';
    const filtered = query
      ? terminalInstrumentCatalog.filter(instrument =>
          [instrument.ticker, instrument.name, instrument.assetClass, instrument.sector ?? '']
            .some(value => value.toLocaleLowerCase().includes(query)))
      : terminalInstrumentCatalog;
    res.setHeader('Cache-Control', 'public, max-age=30');
    return res.json({
      total: filtered.length,
      limit,
      offset,
      instruments: filtered.slice(offset, offset + limit).map(({ id, ticker, name, assetClass, price, currency, exchange }) =>
        ({ id, ticker, name, assetClass, price, currency, exchange }))
    });
});

app.get('/api/terminal/v1/events', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=30');
    return res.json({
      events: linkedTerminalEvents.map(({ event, affectedAssets }) => ({
        id: event.id,
        title: event.title,
        layer: event.layer,
        category: event.category,
        severity: event.severity,
        timestamp: event.timestamp,
        region: event.region,
        summary: event.summary,
        source: event.sourceOrg,
        affectedAssets
      }))
    });
});

app.get('/api/terminal/v1/news', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=30');
    return res.json({
      news: COMPREHENSIVE_FINANCIAL_NEWS.slice(0, 100).map(({ id, timestamp, source, headline, category, impact, relatedTickers, summary }) =>
        ({ id, timestamp, source, headline, category, impact, relatedTickers, summary }))
    });
});

app.post('/api/analyst/chat', async (req, res) => {
    const question = req.body && typeof req.body.question === 'string' ? req.body.question.trim() : '';
    if (question.length < 2 || question.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(question)) {
      return res.status(400).json({ error: 'Question must contain 2 to 2,000 printable characters.' });
    }
    if (!req.body || typeof req.body.context !== 'object' || req.body.context === null || Array.isArray(req.body.context)) {
      return res.status(400).json({ error: 'A terminal context object is required.' });
    }
    const history = req.body.history ?? [];
    if (!Array.isArray(history) || history.length > 8 || history.some((message: unknown) =>
      typeof message !== 'object' || message === null
      || !['user', 'assistant'].includes(String((message as { role?: unknown }).role))
      || typeof (message as { text?: unknown }).text !== 'string'
      || ((message as { text: string }).text.length > 2000))) {
      return res.status(400).json({ error: 'Chat history must contain no more than 8 valid messages.' });
    }
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: 'AI analyst is not configured. Set GEMINI_API_KEY on the server.' });
    }
    const context = JSON.stringify(req.body.context);
    if (context.length > 24_000) {
      return res.status(413).json({ error: 'Analyst context exceeds the 24 KB limit.' });
    }

    try {
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        config: {
          systemInstruction: 'You are Finerd Terminal’s financial research analyst. Answer from the supplied terminal snapshot only; distinguish observed facts from interpretation, state when information is missing, and never invent prices, events, or portfolio data. Do not provide personalized investment advice or execution instructions. Keep answers clear and concise.'
        },
        contents: [
          ...history.map((message: { role: 'user' | 'assistant'; text: string }) => ({
            role: message.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: message.text }]
          })),
          { role: 'user', parts: [{ text: `Terminal snapshot JSON:\n${context}\n\nUser request:\n${question}` }] }
        ]
      });
      const answer = response.text?.trim();
      if (!answer) return res.status(502).json({ error: 'The analyst provider returned no text.' });
      return res.json({ answer });
    } catch {
      return res.status(502).json({ error: 'The AI analyst provider is unavailable. Verify the server key and try again.' });
    }
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

// Search an issuer's latest SEC annual filing for verbatim supplier/customer
// references. The returned text is filing context, not extracted entity data.
app.post('/api/issuer-filings/search', async (req, res) => {
  const ticker = typeof req.body?.ticker === 'string' ? req.body.ticker.trim() : '';
  const companyName = typeof req.body?.companyName === 'string' ? req.body.companyName.trim() : '';
  const contactEmail = typeof req.body?.contactEmail === 'string' ? req.body.contactEmail.trim() : '';
  if (!ticker || ticker.length > 32 || !isValidSymbol(ticker)
    || companyName.length < 2 || companyName.length > 160
    || /[\u0000-\u001f\u007f]/.test(companyName)) {
    return res.status(400).json({ error: 'A valid issuer ticker and company name are required.' });
  }
  if (contactEmail.length > 254 || !/^[^\s@,;<>]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(contactEmail)) {
    return res.status(400).json({ error: 'Enter a valid contact email for the SEC request User-Agent.' });
  }

  const now = Date.now();
  const cacheKey = `${normalizeSecTicker(ticker)}:${normalizeIssuerName(companyName)}`;
  const cached = secAnnualFilingCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({ success: true, provider: 'SEC EDGAR', cached: true, ...cached.result });
  }

  const headers = {
    'User-Agent': `Finerd Terminal public filing research ${contactEmail}`,
    Accept: 'application/json, text/html;q=0.9, */*;q=0.8'
  };

  try {
    let issuers: SecIssuer[];
    if (secIssuerIndexCache && secIssuerIndexCache.expiresAt > now) {
      issuers = secIssuerIndexCache.issuers;
    } else {
      const indexResponse = await fetch('https://www.sec.gov/files/company_tickers.json', {
        headers,
        signal: AbortSignal.timeout(10_000)
      });
      if (!indexResponse.ok) {
        return res.status(502).json({ error: `SEC issuer index returned HTTP ${indexResponse.status}.` });
      }
      const indexPayload = await indexResponse.json() as Record<string, SecIssuer>;
      issuers = Object.values(indexPayload).filter(issuer =>
        Number.isInteger(issuer.cik_str) && typeof issuer.ticker === 'string' && typeof issuer.title === 'string'
      );
      secIssuerIndexCache = { issuers, expiresAt: now + SEC_INDEX_CACHE_TTL_MS };
    }

    const normalizedTicker = normalizeSecTicker(ticker);
    const normalizedCompanyName = normalizeIssuerName(companyName);
    const issuer = issuers.find(candidate => candidate.ticker.toUpperCase() === normalizedTicker)
      ?? issuers.find(candidate => normalizeIssuerName(candidate.title) === normalizedCompanyName);
    if (!issuer) {
      return res.status(404).json({
        error: 'No matching issuer was found in the SEC company index. This listing may not file reports with the SEC.'
      });
    }

    const cik = String(issuer.cik_str).padStart(10, '0');
    const submissionsResponse = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
      headers,
      signal: AbortSignal.timeout(10_000)
    });
    if (!submissionsResponse.ok) {
      return res.status(502).json({ error: `SEC submissions endpoint returned HTTP ${submissionsResponse.status}.` });
    }
    const submissions = await submissionsResponse.json() as {
      filings?: {
        recent?: {
          form?: string[];
          filingDate?: string[];
          accessionNumber?: string[];
          primaryDocument?: string[];
        };
      };
    };
    const recent = submissions.filings?.recent;
    const filingIndex = recent?.form?.findIndex(form => form === '10-K' || form === '20-F' || form === '40-F') ?? -1;
    const accessionNumber = filingIndex >= 0 ? recent?.accessionNumber?.[filingIndex] : undefined;
    const primaryDocument = filingIndex >= 0 ? recent?.primaryDocument?.[filingIndex] : undefined;
    const filingDate = filingIndex >= 0 ? recent?.filingDate?.[filingIndex] : undefined;

    if (!accessionNumber || !primaryDocument || !filingDate
      || !/^[A-Za-z0-9_.-]{1,180}$/.test(primaryDocument) || primaryDocument.includes('..')
      || !/^\d{10}-\d{2}-\d{6}$/.test(accessionNumber)) {
      const result: SecAnnualFilingResult = { filing: null, supplierReferences: [], customerReferences: [] };
      secAnnualFilingCache.set(cacheKey, { result, expiresAt: now + SEC_CACHE_TTL_MS });
      return res.json({ success: true, provider: 'SEC EDGAR', cached: false, ...result });
    }

    const archiveUrl = `https://www.sec.gov/Archives/edgar/data/${issuer.cik_str}/${accessionNumber.replace(/-/g, '')}/${primaryDocument}`;
    const filingResponse = await fetch(archiveUrl, {
      headers,
      signal: AbortSignal.timeout(15_000)
    });
    if (!filingResponse.ok) {
      return res.status(502).json({ error: `SEC filing archive returned HTTP ${filingResponse.status}.` });
    }
    const contentLength = Number(filingResponse.headers.get('content-length') || 0);
    if (contentLength > SEC_FILING_MAX_BYTES) {
      return res.status(502).json({ error: 'SEC filing exceeds the 15 MB processing limit.' });
    }
    const filingBytes = await filingResponse.arrayBuffer();
    if (filingBytes.byteLength > SEC_FILING_MAX_BYTES) {
      return res.status(502).json({ error: 'SEC filing exceeds the 15 MB processing limit.' });
    }
    const filingHtml = new TextDecoder('utf-8').decode(filingBytes);
    const result: SecAnnualFilingResult = {
      filing: {
        form: recent?.form?.[filingIndex] || 'Annual filing',
        filingDate,
        url: archiveUrl
      },
      supplierReferences: extractFilingReferences(filingHtml, /\b(?:supplier|suppliers|vendor|vendors)\b/i),
      customerReferences: extractFilingReferences(filingHtml, /\b(?:customer|customers|client|clients)\b/i)
    };
    secAnnualFilingCache.set(cacheKey, { result, expiresAt: now + SEC_CACHE_TTL_MS });
    if (secAnnualFilingCache.size > 500) {
      const oldest = secAnnualFilingCache.keys().next().value;
      if (oldest !== undefined) secAnnualFilingCache.delete(oldest);
    }
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({ success: true, provider: 'SEC EDGAR', cached: false, ...result });
  } catch (error) {
    const message = error instanceof Error && error.name === 'TimeoutError'
      ? 'SEC EDGAR request timed out.'
      : 'SEC EDGAR is unavailable. Check network access and try again.';
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
      server.on('upgrade', (request, socket, head) => {
        let origin: URL;
        try {
          if (!request.headers.origin || !request.headers.host) throw new Error('Missing origin.');
          origin = new URL(request.headers.origin);
        } catch {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        const expectedProtocol = process.env.PUBLIC_HTTPS === 'true' ? 'https:' : 'http:';
        if (origin.host !== request.headers.host || origin.protocol !== expectedProtocol) {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        if (new URL(request.url ?? '/', `http://${request.headers.host}`).pathname !== '/api/terminal/v1/stream') {
          socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        terminalWebSocketServer.handleUpgrade(request, socket, head, webSocket => {
          terminalWebSocketServer.emit('connection', webSocket, request);
        });
      });
      app.use(genericErrorHandler);
      const address = server.address();
      const boundPort = typeof address === 'object' && address ? address.port : PORT;
      console.log(`[Finerd Terminal] Server listening on ${host}:${boundPort}`);
      resolve(server);
    });
    server.once('error', reject);
  });
}

terminalWebSocketServer.on('connection', webSocket => {
  const sendSnapshot = () => {
    if (webSocket.readyState !== webSocket.OPEN) return;
    const quotes = [...quoteCache.entries()].slice(-500).map(([symbol, quote]) => ({
      symbol,
      price: quote.price,
      change: quote.change,
      changePercent: quote.changePercent,
      currency: quote.currency,
      updatedAt: quote.updatedAt
    }));
    webSocket.send(JSON.stringify({ type: 'market.snapshot', timestamp: new Date().toISOString(), quotes }));
  };
  sendSnapshot();
  const timer = setInterval(sendSnapshot, 5000);
  webSocket.on('close', () => clearInterval(timer));
  webSocket.on('error', () => clearInterval(timer));
});

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
