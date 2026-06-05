import { TradingBot } from '../bot';
import { BotConfig } from '../config';
import { logger } from '../logger';

export class ScalpBot extends TradingBot {
  private priceHistory: number[] = [];
  private positionOpenedAt: Date | null = null;
  private readonly holdMinutes: number;
  private readonly momentumPeriod: number;
  private readonly momentumThreshold: number;

  constructor(
    config: BotConfig,
    holdMinutes = 5,
    momentumPeriod = 10,
    momentumThreshold = 0.05
  ) {
    super(config);
    this.holdMinutes = holdMinutes;
    this.momentumPeriod = momentumPeriod;
    this.momentumThreshold = momentumThreshold;
  }

  public async start(): Promise<void> {
    logger.info(`Scalp strategy | hold=${this.holdMinutes}min | momentum period=${this.momentumPeriod} ticks | threshold=${this.momentumThreshold}%`);
    return super.start();
  }

  protected shouldOpenLong(price: number): boolean {
    this.recordPrice(price);
    if (this.priceHistory.length < this.momentumPeriod) {
      logger.debug(`Accumulating price history... ${this.priceHistory.length}/${this.momentumPeriod}`);
      return false;
    }
    const momentum = this.getMomentum();
    logger.debug(`Momentum: ${momentum.toFixed(3)}% | threshold: ±${this.momentumThreshold}%`);
    return momentum > this.momentumThreshold;
  }

  protected shouldOpenShort(price: number): boolean {
    if (this.priceHistory.length < this.momentumPeriod) return false;
    const momentum = this.getMomentum();
    return momentum < -this.momentumThreshold;
  }

  protected async onPositionCheck(): Promise<boolean> {
    if (!this.positionOpenedAt) return false;
    const minutesHeld = (Date.now() - this.positionOpenedAt.getTime()) / 60000;
    if (minutesHeld >= this.holdMinutes) {
      logger.info(`⏱ Time limit reached (${minutesHeld.toFixed(1)} min) → closing`);
      return true;
    }
    logger.debug(`Position held for ${minutesHeld.toFixed(1)}/${this.holdMinutes} min`);
    return false;
  }

  protected onPositionOpened(): void {
    this.positionOpenedAt = new Date();
    logger.info(`⏱ Position timer started | closes in ${this.holdMinutes} min or on SL/TP`);
  }

  protected onPositionClosed(): void {
    this.positionOpenedAt = null;
    logger.info('Position closed, looking for next signal...');
  }

  private recordPrice(price: number): void {
    this.priceHistory.push(price);
    if (this.priceHistory.length > this.momentumPeriod * 3) {
      this.priceHistory.shift();
    }
  }

  private getMomentum(): number {
    if (this.priceHistory.length < this.momentumPeriod) return 0;
    const old = this.priceHistory[this.priceHistory.length - this.momentumPeriod];
    const current = this.priceHistory[this.priceHistory.length - 1];
    return ((current - old) / old) * 100;
  }
}
