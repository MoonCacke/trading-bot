import { logger } from '../logger';
import { spawn } from 'child_process';

const LIGHTER_BASE_URL = 'https://mainnet.zklighter.elliot.ai';

export interface LighterConfig {
  accountIndex: number;
  apiKeyIndex: number;
  apiPrivateKey: string;
}

export interface LighterOrderResult {
  txHash: string;
  clientOrderIndex: number;
}

export interface LighterMarketStats {
  symbol: string;
  marketId: number;
  markPrice: number;
  midPrice: number;
  currentFundingRate: number;
  fundingRate: number;
}

export interface LighterPosition {
  marketId: number;
  side: 'long' | 'short' | 'none';
  size: number;
  entryPrice: number;
  unrealizedPnl: number;
  fundingPaidOut: number;
}

export interface OrderBookDetails {
  marketIndex: number;
  sizeDecimals: number;
  priceDecimals: number;
  minBaseAmount: number;
  minQuoteAmount: number;
}

export class LighterClient {
  private config: LighterConfig;
  private clientOrderCounter: number = Math.floor(Math.random() * 100000) + 10000;

  static readonly ORDER_TYPE_MARKET = 1;
  static readonly ORDER_TYPE_LIMIT  = 0;
  static readonly TIF_IOC           = 0;
  static readonly TIF_GTT           = 1;

  constructor(config: LighterConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    logger.info(`LighterClient initializing | account=${this.config.accountIndex}`);
    logger.info('LighterClient ready | using python3 lighter_order.py');
  }

  async getMarketStats(marketIndex: number): Promise<LighterMarketStats> {
    const data = await this.get(`/api/v1/marketStats?market_id=${marketIndex}`);
    const s = data.market_stats ?? data;
    return {
      symbol:             s.symbol ?? '',
      marketId:           Number(s.market_id ?? marketIndex),
      markPrice:          parseFloat(s.mark_price ?? '0'),
      midPrice:           parseFloat(s.mid_price ?? '0'),
      currentFundingRate: parseFloat(s.current_funding_rate ?? '0'),
      fundingRate:        parseFloat(s.funding_rate ?? '0'),
    };
  }

  async getOrderBookDetails(marketIndex: number): Promise<OrderBookDetails> {
    const data = await this.get(`/api/v1/orderBookDetails?market_id=${marketIndex}`);
    // order_book_details — это массив, берём первый элемент
    const arr = data.order_book_details;
    const d = Array.isArray(arr) ? arr[0] : (arr ?? data);
    return {
      marketIndex:    Number(d.market_index ?? marketIndex),
      sizeDecimals:   Number(d.supported_size_decimals ?? 4),
      priceDecimals:  Number(d.supported_price_decimals ?? 2),
      minBaseAmount:  Number(d.min_base_amount ?? 0),
      minQuoteAmount: Number(d.min_quote_amount ?? 0),
    };
  }

  async getMidPrice(marketIndex: number): Promise<number> {
    const stats = await this.getMarketStats(marketIndex);
    return stats.midPrice;
  }

  async getPosition(marketIndex: number): Promise<LighterPosition> {
    const data = await this.get(`/api/v1/account?account_index=${this.config.accountIndex}`);
    const positions = data.positions ?? {};
    const p = positions[String(marketIndex)];
    if (!p) {
      return { marketId: marketIndex, side: 'none', size: 0, entryPrice: 0, unrealizedPnl: 0, fundingPaidOut: 0 };
    }
    const sign = Number(p.sign ?? 0);
    return {
      marketId:       marketIndex,
      side:           sign > 0 ? 'long' : sign < 0 ? 'short' : 'none',
      size:           parseFloat(p.position ?? '0'),
      entryPrice:     parseFloat(p.avg_entry_price ?? '0'),
      unrealizedPnl:  parseFloat(p.unrealized_pnl ?? '0'),
      fundingPaidOut: parseFloat(p.total_funding_paid_out ?? '0'),
    };
  }

  async marketShort(marketIndex: number, sizeEth: number, worstPrice: number): Promise<LighterOrderResult> {
    const details    = await this.getOrderBookDetails(marketIndex);
    const baseAmount = Math.round(sizeEth * Math.pow(10, details.sizeDecimals));
    const priceInt   = Math.round(worstPrice * Math.pow(10, details.priceDecimals));
    logger.info(`Lighter SHORT | market=${marketIndex} size=${sizeEth} ETH (${baseAmount} units) | worstPrice=${worstPrice.toFixed(2)}`);
    return this.sendOrder({ marketIndex, baseAmount, price: priceInt, isAsk: true, orderType: LighterClient.ORDER_TYPE_MARKET, timeInForce: LighterClient.TIF_IOC, reduceOnly: false });
  }

  async marketLong(marketIndex: number, sizeEth: number, worstPrice: number): Promise<LighterOrderResult> {
    const details    = await this.getOrderBookDetails(marketIndex);
    const baseAmount = Math.round(sizeEth * Math.pow(10, details.sizeDecimals));
    const priceInt   = Math.round(worstPrice * Math.pow(10, details.priceDecimals));
    logger.info(`Lighter LONG | market=${marketIndex} size=${sizeEth} ETH (${baseAmount} units) | worstPrice=${worstPrice.toFixed(2)}`);
    return this.sendOrder({ marketIndex, baseAmount, price: priceInt, isAsk: false, orderType: LighterClient.ORDER_TYPE_MARKET, timeInForce: LighterClient.TIF_IOC, reduceOnly: false });
  }

  async closePosition(marketIndex: number, currentSide: 'long' | 'short' | 'none', sizeEth: number, currentPrice = 0): Promise<void> {
    if (currentSide === 'none' || sizeEth <= 0) {
      logger.warn('LighterClient.closePosition: no position to close');
      return;
    }
    const details    = await this.getOrderBookDetails(marketIndex);
    const baseAmount = Math.round(sizeEth * Math.pow(10, details.sizeDecimals));

    // Используем переданную цену или пробуем получить через REST
    let midPrice = currentPrice;
    if (midPrice === 0) {
      try {
        midPrice = await this.getMidPrice(marketIndex);
      } catch (err) {
        logger.warn(`getMidPrice failed, using fallback price 2000: ${err}`);
        midPrice = 2000;
      }
    }

    const worstPrice = currentSide === 'long' ? midPrice * 0.90 : midPrice * 1.10;
    const priceInt   = Math.round(worstPrice * Math.pow(10, details.priceDecimals));
    logger.info(`Lighter CLOSE ${currentSide.toUpperCase()} | market=${marketIndex} size=${sizeEth} ETH | mid=${midPrice.toFixed(2)}`);

    // Retry логика: 3 попытки с паузой 5 сек
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 5000;
    let lastError: any;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.sendOrder({ marketIndex, baseAmount, price: priceInt, isAsk: currentSide === 'long', orderType: LighterClient.ORDER_TYPE_MARKET, timeInForce: LighterClient.TIF_IOC, reduceOnly: true });
        return; // успех — выходим
      } catch (err) {
        lastError = err;
        logger.warn(`Lighter closePosition attempt ${attempt}/${MAX_RETRIES} failed: ${err}`);
        if (attempt < MAX_RETRIES) {
          logger.info(`Retrying in ${RETRY_DELAY_MS / 1000}s...`);
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        }
      }
    }
    throw new Error(`Lighter closePosition failed after ${MAX_RETRIES} attempts: ${lastError}`);
  }

  private async sendOrder(params: {
    marketIndex: number; baseAmount: number; price: number;
    isAsk: boolean; orderType: number; timeInForce: number; reduceOnly: boolean;
  }): Promise<LighterOrderResult> {
    const clientOrderIndex = this.nextClientOrderIndex();

    const orderParams = JSON.stringify({
      market_index:       params.marketIndex,
      client_order_index: clientOrderIndex,
      base_amount:        params.baseAmount,
      price:              params.price,
      is_ask:             params.isAsk,
      order_type:         params.orderType,
      time_in_force:      params.timeInForce,
      reduce_only:        params.reduceOnly,
    });

    logger.info(`Calling lighter_order.py | clientIdx=${clientOrderIndex}`);

    const result = await new Promise<any>((resolve, reject) => {
      const proc = spawn('python3.11', ['lighter_order.py'], { cwd: process.cwd(), env: { ...process.env, PATH: process.env.PATH } });
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      proc.on('close', (_code: number) => {
        const cleanStderr = stderr
          .split('\n')
          .filter((l: string) =>
            !l.includes('NotOpenSSLWarning') &&
            !l.includes('urllib3') &&
            !l.includes('Unclosed') &&
            !l.includes('connector') &&
            !l.includes('client_session') &&
            !l.includes('connections:') &&
            !l.includes('deque') &&
            !l.includes('ResponseHandler') &&
            l.trim()
          )
          .join('\n');
        if (cleanStderr) logger.warn(`lighter_order.py stderr: ${cleanStderr}`);
        try {
          const lines = stdout.trim().split('\n');
          const lastLine = lines[lines.length - 1];
          resolve(JSON.parse(lastLine));
        } catch (e) {
          reject(new Error(`Failed to parse output: ${stdout}`));
        }
      });

      proc.on('error', reject);
      proc.stdin.write(orderParams);
      proc.stdin.end();
    });

    if (result.error) throw new Error(`lighter_order.py error: ${result.error}`);

    logger.info(`Lighter order submitted | clientIdx=${clientOrderIndex} txHash=${result.tx_hash}`);
    return { txHash: result.tx_hash, clientOrderIndex };
  }

  private nextClientOrderIndex(): number {
    return this.clientOrderCounter++;
  }

  private async get(path: string): Promise<any> {
    const res = await fetch(`${LIGHTER_BASE_URL}${path}`, {
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Lighter GET ${path} → ${res.status}: ${text}`);
    }
    return res.json();
  }
}
