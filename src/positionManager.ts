import { ExchangeClient, InfoClient } from 'risex-client';
import { logger } from './logger';
import { BotConfig } from './config';

const MAINNET_URL = 'https://api.rise.trade';
const MAINNET_WS  = 'wss://ws.rise.trade/ws';

export type Side = 'long' | 'short';

export interface PositionState {
  marketId: number;
  side: Side;
  size: number;
  entryPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  openedAt: Date;
}

export class PositionManager {
  private client: ExchangeClient;
  private info: InfoClient;
  private config: BotConfig;
  private activePosition: PositionState | null = null;
  private lastClosePrice: number = 0;

  constructor(config: BotConfig) {
    this.config = config;
    this.info = new InfoClient({ baseUrl: MAINNET_URL });
    this.client = new ExchangeClient({
      account: config.accountAddress,
      signerKey: config.signerPrivateKey,
      baseUrl: MAINNET_URL,
      wsUrl: MAINNET_WS,
    });
  }

  async init(): Promise<void> {
    logger.info('Initializing ExchangeClient...');
    await this.client.init();
    logger.info('ExchangeClient ready');
  }

  async getCurrentPrice(marketId: number): Promise<number> {
    const markets = await this.info.getMarkets();
    const market = markets.find((m: any) => String(m.market_id) === String(marketId));
    if (!market) throw new Error(`Market ${marketId} not found`);
    return parseFloat(market.last_price);
  }

  async openLong(marketId: number, sizeSteps: number): Promise<PositionState> {
    const entryPrice = await this.getCurrentPrice(marketId);
    logger.info(`Opening LONG | market=${marketId} size=${sizeSteps} steps | entry≈${entryPrice}`);
    const order = await this.client.marketBuy(marketId, sizeSteps);
    logger.info(`Order filled | id=${order.order_id}`);
    const position = this.buildPositionState(marketId, 'long', sizeSteps, entryPrice);
    this.activePosition = position;
    this.logPositionSummary(position);
    return position;
  }

  async openShort(marketId: number, sizeSteps: number): Promise<PositionState> {
    const entryPrice = await this.getCurrentPrice(marketId);
    logger.info(`Opening SHORT | market=${marketId} size=${sizeSteps} steps | entry≈${entryPrice}`);
    const order = await this.client.marketSell(marketId, sizeSteps);
    logger.info(`Order filled | id=${order.order_id}`);
    const position = this.buildPositionState(marketId, 'short', sizeSteps, entryPrice);
    this.activePosition = position;
    this.logPositionSummary(position);
    return position;
  }

  async closePosition(reason: string): Promise<void> {
    if (!this.activePosition) {
      logger.warn('closePosition called but no active position');
      return;
    }
    const { marketId } = this.activePosition;
    logger.info(`Closing position | reason=${reason}`);
    try {
      await this.client.closePosition(marketId);
      const closePrice = await this.getCurrentPrice(marketId);
      this.lastClosePrice = closePrice;
      const pnl = this.calcPnl(this.activePosition, closePrice);
      logger.info(`Position closed | closePrice=${closePrice} | PnL≈$${pnl.toFixed(4)}`);
    } catch (err) {
      logger.error(`Failed to close position: ${err}`);
      throw err;
    } finally {
      this.activePosition = null;
    }
  }

  async checkStopLossTakeProfit(): Promise<'sl' | 'tp' | null> {
    if (!this.activePosition) return null;
    const currentPrice = await this.getCurrentPrice(this.activePosition.marketId);
    const { side, stopLossPrice, takeProfitPrice, entryPrice } = this.activePosition;
    const pct = ((currentPrice - entryPrice) / entryPrice) * 100 * (side === 'long' ? 1 : -1);
    logger.debug(`SL/TP check | price=${currentPrice} SL=${stopLossPrice} TP=${takeProfitPrice} PnL≈${pct.toFixed(2)}%`);

    if (side === 'long') {
      if (currentPrice <= stopLossPrice) {
        logger.warn(`⛔ STOP-LOSS | price=${currentPrice} <= SL=${stopLossPrice}`);
        await this.closePosition('stop-loss');
        return 'sl';
      }
      if (currentPrice >= takeProfitPrice) {
        logger.info(`✅ TAKE-PROFIT | price=${currentPrice} >= TP=${takeProfitPrice}`);
        await this.closePosition('take-profit');
        return 'tp';
      }
    } else {
      if (currentPrice >= stopLossPrice) {
        logger.warn(`⛔ STOP-LOSS | price=${currentPrice} >= SL=${stopLossPrice}`);
        await this.closePosition('stop-loss');
        return 'sl';
      }
      if (currentPrice <= takeProfitPrice) {
        logger.info(`✅ TAKE-PROFIT | price=${currentPrice} <= TP=${takeProfitPrice}`);
        await this.closePosition('take-profit');
        return 'tp';
      }
    }
    return null;
  }

  getActivePosition(): PositionState | null { return this.activePosition; }
  hasOpenPosition(): boolean { return this.activePosition !== null; }
  getLastClosePrice(): number { return this.lastClosePrice; }

  private buildPositionState(marketId: number, side: Side, sizeSteps: number, entryPrice: number): PositionState {
    const slMult = side === 'long' ? 1 - this.config.stopLossPct / 100 : 1 + this.config.stopLossPct / 100;
    const tpMult = side === 'long' ? 1 + this.config.takeProfitPct / 100 : 1 - this.config.takeProfitPct / 100;
    return {
      marketId, side, size: sizeSteps, entryPrice,
      stopLossPrice: parseFloat((entryPrice * slMult).toFixed(2)),
      takeProfitPrice: parseFloat((entryPrice * tpMult).toFixed(2)),
      openedAt: new Date(),
    };
  }

  private calcPnl(position: PositionState, closePrice: number): number {
    const diff = closePrice - position.entryPrice;
    return position.side === 'long' ? diff * position.size * 0.001 : -diff * position.size * 0.001;
  }

  private logPositionSummary(pos: PositionState): void {
    logger.info(`Position | side=${pos.side.toUpperCase()} entry=${pos.entryPrice} SL=${pos.stopLossPrice} TP=${pos.takeProfitPrice}`);
  }
}
