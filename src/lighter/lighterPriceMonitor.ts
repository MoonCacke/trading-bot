import WebSocket from 'ws';
import { logger } from '../logger';

const LIGHTER_WS_URL = 'wss://mainnet.zklighter.elliot.ai/stream';

type PriceCallback   = (price: number) => void;
type FundingCallback = (rate: number) => void;

export class LighterPriceMonitor {
  private ws: WebSocket | null = null;
  private marketIndex: number;
  private onPrice: PriceCallback;
  private onFunding: FundingCallback;
  private running = false;
  private reconnectCount = 0;
  private isConnecting = false;
  private keepaliveTimer: NodeJS.Timeout | null = null;

  public lastPrice   = 0;
  public lastFunding = 0;

  constructor(
    marketIndex: number,
    onPrice: PriceCallback,
    onFunding: FundingCallback
  ) {
    this.marketIndex = marketIndex;
    this.onPrice   = onPrice;
    this.onFunding = onFunding;
  }

  async start(): Promise<void> {
    this.running = true;
    await this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    if (this.ws) this.ws.close();
    logger.info('LighterPriceMonitor stopped');
  }

  private async connect(): Promise<void> {
    if (this.isConnecting) {
      logger.debug('LighterPriceMonitor already connecting, skipping...');
      return;
    }
    this.isConnecting = true;
    return new Promise((resolve) => {
      logger.info(`LighterPriceMonitor connecting | market=${this.marketIndex}`);

      if (this.ws) { try { this.ws.close(); } catch (_) {} this.ws = null; }
      this.ws = new WebSocket(LIGHTER_WS_URL);

      this.ws.on('open', () => {
        logger.info('Lighter WebSocket open, subscribing...');
        this.reconnectCount = 0;

        this.ws!.send(JSON.stringify({
          type: 'subscribe',
          channel: `ticker/${this.marketIndex}`,
        }));

        this.ws!.send(JSON.stringify({
          type: 'subscribe',
          channel: `market_stats/${this.marketIndex}`,
        }));

        this.keepaliveTimer = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.ping();
          }
        }, 90_000);

        resolve();
      this.isConnecting = false;
      });

      this.ws.on('message', (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString());
          this.handleMessage(msg);
        } catch { }
      });

      this.ws.on('error', (err) => {
        logger.error(`Lighter WS error: ${err}`);
      });

      this.ws.on('close', () => {
        if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
        if (this.running) {
          this.reconnectCount++;
          const delay = Math.min(5000 * this.reconnectCount, 60_000);
          logger.warn(`Lighter WS closed, reconnecting in ${delay / 1000}s (attempt ${this.reconnectCount})...`);
          setTimeout(() => { this.ws = null; this.isConnecting = false; this.connect(); }, delay);
        }
      });
    });
  }

  private handleMessage(msg: any): void {
    const type = msg.type ?? '';

    if (type === 'update/ticker' || type === 'subscribed/ticker') {
      const ticker = msg.ticker;
      if (!ticker) return;

      const ask = parseFloat(ticker.a?.price ?? '0');
      const bid = parseFloat(ticker.b?.price ?? '0');

      if (ask > 0 && bid > 0) {
        const mid = (ask + bid) / 2;
        if (mid !== this.lastPrice) {
          this.lastPrice = mid;
          this.onPrice(mid);
          logger.debug(`Lighter price | ask=${ask} bid=${bid} mid=${mid.toFixed(2)}`);
        }
      }
      return;
    }

    if (type === 'update/market_stats' || type === 'subscribed/market_stats') {
      const stats = msg.market_stats;
      if (!stats) return;

      const rate = parseFloat(stats.current_funding_rate ?? '0');
      if (rate !== this.lastFunding) {
        this.lastFunding = rate;
        this.onFunding(rate);
        logger.debug(`Lighter funding rate: ${rate.toFixed(4)}%`);
      }

      if (this.lastPrice === 0) {
        const mark = parseFloat(stats.mark_price ?? '0');
        if (mark > 0) {
          this.lastPrice = mark;
          this.onPrice(mark);
        }
      }
      return;
    }
  }
}
