import { PositionManager } from './positionManager';
import { PriceMonitor } from './priceMonitor';
import { logger } from './logger';
import { BotConfig } from './config';

export class TradingBot {
  private positionManager: PositionManager;
  private priceMonitor: PriceMonitor;
  protected config: BotConfig;
  private monitorTimer: NodeJS.Timeout | null = null;
  private running = false;
  private isClosing = false;
  protected currentPrice = 0;

  constructor(config: BotConfig) {
    this.config = config;
    this.positionManager = new PositionManager(config);
    this.priceMonitor = new PriceMonitor(config.marketId, (price) => {
      this.currentPrice = price;
    });
  }

  public async start(): Promise<void> {
    logger.info('═══════════════════════════════════════');
    logger.info('     RISEx Scalp Bot starting          ');
    logger.info('═══════════════════════════════════════');
    logger.info(`Market: ${this.config.marketId} | SL: ${this.config.stopLossPct}% | TP: ${this.config.takeProfitPct}%`);

    await this.positionManager.init();
    await this.priceMonitor.start();
    await this.waitForPrice();

    this.running = true;
    this.scheduleMonitor();

    process.on('SIGINT', () => { this.shutdown('SIGINT').catch(console.error); });
    process.on('SIGTERM', () => { this.shutdown('SIGTERM').catch(console.error); });

    logger.info('Bot is running. Press Ctrl+C to stop.');
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.priceMonitor.stop();
    if (this.positionManager.hasOpenPosition()) {
      logger.warn('Closing open position on shutdown...');
      await this.positionManager.closePosition('bot-shutdown');
    }
    logger.info('Bot stopped.');
  }

  protected shouldOpenLong(_price: number): boolean { return false; }
  protected shouldOpenShort(_price: number): boolean { return false; }
  protected async onPositionCheck(): Promise<boolean> { return false; }
  protected onPositionOpened(): void {}
  protected onPositionClosed(): void {}

  protected get posManager(): PositionManager { return this.positionManager; }

  private scheduleMonitor(): void {
    this.monitorTimer = setInterval(async () => {
      if (!this.running) return;
      try {
        await this.tick();
      } catch (err) {
        logger.error(`Tick error: ${err}`);
      }
    }, this.config.monitorIntervalMs);
  }

  private async tick(): Promise<void> {
    const price = this.currentPrice;
    if (price === 0) {
      logger.warn('No price data, skipping tick');
      return;
    }
    if (this.isClosing) {
      logger.warn('Position is closing, skipping tick...');
      return;
    }

    if (this.positionManager.hasOpenPosition()) {
      const shouldCloseByTime = await this.onPositionCheck();
      if (shouldCloseByTime) {
        this.isClosing = true;
        try {
          await this.positionManager.closePosition('time-limit');
          this.onPositionClosed();
        } catch (err) {
          logger.error(`Failed to close position: ${err}`);
          logger.warn('Will retry closing next tick...');
        } finally {
          this.isClosing = false;
        }
        return;
      }
      const result = await this.positionManager.checkStopLossTakeProfit();
      if (result) this.onPositionClosed();
      return;
    }

    if (this.shouldOpenLong(price)) {
      this.isClosing = true; // блокируем новые попытки
      try {
        await this.positionManager.openLong(this.config.marketId, this.config.positionSizeSteps);
        this.onPositionOpened();
      } catch (err) {
        logger.error(`Failed to open LONG: ${err}`);
        logger.warn('Cooling down 60s after failed open...');
        await new Promise(r => setTimeout(r, 60000));
      } finally {
        this.isClosing = false;
      }
    } else if (this.shouldOpenShort(price)) {
      this.isClosing = true; // блокируем новые попытки
      try {
        await this.positionManager.openShort(this.config.marketId, this.config.positionSizeSteps);
        this.onPositionOpened();
      } catch (err) {
        logger.error(`Failed to open SHORT: ${err}`);
        logger.warn('Cooling down 60s after failed open...');
        await new Promise(r => setTimeout(r, 60000));
      } finally {
        this.isClosing = false;
      }
    } else {
      logger.debug(`No signal | price=${price}`);
    }
  }

  private async waitForPrice(): Promise<void> {
    logger.info('Waiting for first price tick...');
    for (let i = 0; i < 60; i++) {
      if (this.currentPrice > 0) {
        logger.info(`First price received: ${this.currentPrice}`);
        return;
      }
      await sleep(1000);
    }
    throw new Error('Timed out waiting for price data');
  }

  private async shutdown(signal: string): Promise<void> {
    logger.info(`Received ${signal}, shutting down...`);
    await this.stop();
    await new Promise(r => setTimeout(r, 2000));
    process.exit(0);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
