import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { ExchangeClient, InfoClient } from 'risex-client';
import { LighterClient } from './lighter/lighterClient';
import { logger } from './logger';

const MAINNET_URL = 'https://api.rise.trade';
const MAINNET_WS  = 'wss://ws.rise.trade/ws';
const STATE_FILE  = path.join(process.cwd(), 'manual_position.json');

const RISE_MARKET_ID    = 2; // ETH
const LIGHTER_MARKET_ID = 0; // ETH

interface ManualState {
  open: boolean;
  direction: 'rise-long' | 'rise-short';
  sizeEth: number;
  riseEntryPrice: number;
  lighterEntryPrice: number;
  openedAt: string;
}

function loadState(): ManualState | null {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch { return null; }
}

function saveState(s: ManualState | null): void {
  if (s === null) {
    try { fs.unlinkSync(STATE_FILE); } catch {}
  } else {
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  }
}

async function getRiseFunding(): Promise<number> {
  const res = await fetch('https://api.rise.trade/v1/markets');
  const data: any = await res.json();
  const markets = data?.data?.markets ?? [];
  const m = markets.find((x: any) => String(x.market_id) === String(RISE_MARKET_ID));
  return m ? parseFloat(m.current_funding_rate ?? '0') : 0;
}

async function main() {
  const action  = process.argv[2]; // open | close | status
  const sizeUsd = parseFloat(process.argv[3] ?? '300');

  const lighter = new LighterClient({
    accountIndex:  parseInt(process.env.LIGHTER_ACCOUNT_INDEX ?? '0'),
    apiKeyIndex:   parseInt(process.env.LIGHTER_API_KEY_INDEX ?? '2'),
    apiPrivateKey: process.env.LIGHTER_API_PRIVATE_KEY ?? '',
  });

  const info = new InfoClient({ baseUrl: MAINNET_URL });
  const rise = new ExchangeClient({
    account:   process.env.ACCOUNT_ADDRESS!,
    signerKey: process.env.SIGNER_PRIVATE_KEY!,
    baseUrl:   MAINNET_URL,
    wsUrl:     MAINNET_WS,
  });

  if (action === 'status') {
    const state = loadState();
    console.log(JSON.stringify({ ok: true, state }));
    process.exit(0);
  }

  await rise.init();
  await lighter.init();

  if (action === 'open') {
    const existing = loadState();
    if (existing?.open) {
      console.log(JSON.stringify({ ok: false, message: 'Позиция уже открыта' }));
      process.exit(0);
    }

    // Цены
    const markets = await info.getMarkets();
    const market = markets.find((m: any) => String(m.market_id) === String(RISE_MARKET_ID));
    if (!market) throw new Error('Rise market not found');
    const risePrice    = parseFloat((market as any).last_price);
    const lighterPrice = await lighter.getMidPrice(LIGHTER_MARKET_ID);

    // Направление по funding спреду
    const riseFunding    = await getRiseFunding();
    const lighterStats   = await lighter.getMarketStats(LIGHTER_MARKET_ID);
    const lighterFunding = lighterStats.currentFundingRate;
    const spread = riseFunding - (lighterFunding / 100);
    const direction: 'rise-long' | 'rise-short' = spread > 0 ? 'rise-long' : 'rise-short';

    // Размер
    const sizeEth   = parseFloat((sizeUsd / risePrice).toFixed(4));
    const sizeSteps = Math.round(sizeEth / 0.001);

    logger.info(`🖐 Ручное открытие | $${sizeUsd} (${sizeEth} ETH / ${sizeSteps} steps) | ${direction} | спред=${(spread * 100).toFixed(6)}%`);

    // Открываем Rise
    if (direction === 'rise-long') {
      await rise.marketBuy(RISE_MARKET_ID, sizeSteps);
    } else {
      await rise.marketSell(RISE_MARKET_ID, sizeSteps);
    }
    logger.info(`Rise ${direction === 'rise-long' ? 'LONG' : 'SHORT'} открыт`);

    // Открываем Lighter противоположно
    try {
      if (direction === 'rise-long') {
        await lighter.marketShort(LIGHTER_MARKET_ID, sizeEth, lighterPrice * 0.995);
      } else {
        await lighter.marketLong(LIGHTER_MARKET_ID, sizeEth, lighterPrice * 1.05);
      }
      logger.info(`Lighter ${direction === 'rise-long' ? 'SHORT' : 'LONG'} открыт`);
    } catch (err) {
      logger.error(`Lighter не открылся, закрываем Rise: ${err}`);
      await rise.closePosition(RISE_MARKET_ID);
      console.log(JSON.stringify({ ok: false, message: `Lighter ошибка: ${err}` }));
      process.exit(1);
    }

    saveState({
      open: true,
      direction,
      sizeEth,
      riseEntryPrice: risePrice,
      lighterEntryPrice: lighterPrice,
      openedAt: new Date().toISOString(),
    });

    console.log(JSON.stringify({ ok: true, message: `Открыто: ${direction} | ${sizeEth} ETH | $${sizeUsd}` }));
    process.exit(0);
  }

  if (action === 'close') {
    const state = loadState();
    if (!state?.open) {
      console.log(JSON.stringify({ ok: false, message: 'Нет открытой ручной позиции' }));
      process.exit(0);
    }

    const lighterPrice = await lighter.getMidPrice(LIGHTER_MARKET_ID);
    const lighterSide: 'long' | 'short' = state.direction === 'rise-long' ? 'short' : 'long';

    // Закрываем Rise через SDK (с reduce_only)
    try {
      await rise.closePosition(RISE_MARKET_ID);
      logger.info('Rise позиция закрыта');
    } catch (err) {
      logger.error(`Rise закрытие ошибка: ${err}`);
    }

    // Закрываем Lighter
    try {
      await lighter.closePosition(LIGHTER_MARKET_ID, lighterSide, state.sizeEth, lighterPrice);
      logger.info('Lighter позиция закрыта');
    } catch (err) {
      logger.error(`Lighter закрытие ошибка: ${err}`);
      console.log(JSON.stringify({ ok: false, message: `Lighter ошибка закрытия: ${err}` }));
      process.exit(1);
    }

    saveState(null);
    console.log(JSON.stringify({ ok: true, message: 'Позиция закрыта (обе ноги)' }));
    process.exit(0);
  }

  console.log(JSON.stringify({ ok: false, message: `Неизвестная команда: ${action}` }));
  process.exit(1);
}

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, message: String(err) }));
  process.exit(1);
});
