import { WebSocketClient } from 'risex-client';
import { logger } from './logger';

type PriceCallback = (price: number) => void;

export class PriceMonitor {
  private ws: WebSocketClient | null = null;
  private marketId: number;
  private onPriceUpdate: PriceCallback;
  private running = false;
  private reconnectCount = 0;
  private isConnecting = false;
  public lastPrice: number = 0;
  private bestAsk: number = 0;
  private bestBid: number = 0;

  constructor(marketId: number, onPriceUpdate: PriceCallback) {
    this.marketId = marketId;
    this.onPriceUpdate = onPriceUpdate;
  }

  async start(): Promise<void> {
    this.running = true;
    await this.connect();
  }

  stop(): void {
    this.running = false;
    logger.info('PriceMonitor stopped');
  }

  private async connect(): Promise<void> {
    if (this.isConnecting) {
      logger.debug('PriceMonitor already connecting, skipping...');
      return;
    }
    this.isConnecting = true;
    return new Promise((resolve) => {
      logger.info(`PriceMonitor connecting | market=${this.marketId}`);

      if (this.ws) {
        try { this.ws.disconnect(); } catch (_) {}
        this.ws = null;
      }
      this.ws = new WebSocketClient();

      this.ws.on('open', () => {
        logger.info('WebSocket open, subscribing to orderbook...');
        this.reconnectCount = 0;
        this.ws!.subscribe({ channel: 'orderbook', market_ids: [this.marketId] });
        resolve();
      });

      this.ws.on('error', (err: unknown) => {
        logger.error(`WebSocket error: ${err}`);
      });

      this.ws.on('close', () => {
        if (this.running) {
          this.reconnectCount++;
          const delay = Math.min(5000 * this.reconnectCount, 60000);
          logger.warn(`WebSocket closed, reconnecting in ${delay / 1000}s (attempt ${this.reconnectCount})...`);
          setTimeout(() => {
            this.ws = null;
            this.isConnecting = false;
            this.connect();
          }, delay);
        }
      });

      this.ws.onChannel('orderbook', (msg: any) => {
        const marketId = msg?.market_id ?? msg?.data?.market_id;
        if (String(marketId) !== String(this.marketId)) return;

        const asks = msg?.data?.asks ?? [];
        const bids = msg?.data?.bids ?? [];

        if (asks.length > 0) {
          const price = parseFloat(asks[0]?.price ?? '0');
          if (price > 0) this.bestAsk = price;
        }
        if (bids.length > 0) {
          const price = parseFloat(bids[0]?.price ?? '0');
          if (price > 0) this.bestBid = price;
        }

        if (this.bestAsk > 0 && this.bestBid > 0) {
          const mid = (this.bestAsk + this.bestBid) / 2;
          if (mid !== this.lastPrice) {
            this.lastPrice = mid;
            this.onPriceUpdate(mid);
            logger.debug(`Price | ask=${this.bestAsk} bid=${this.bestBid} mid=${mid.toFixed(2)}`);
          }
        }
      });

      this.ws.connect();
      this.isConnecting = false;
    });
  }
}
