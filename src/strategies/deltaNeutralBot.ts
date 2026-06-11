import { TradingBot } from '../bot';
import { BotConfig } from '../config';
import { logger } from '../logger';
import { LighterClient } from '../lighter/lighterClient';
import { LighterPriceMonitor } from '../lighter/lighterPriceMonitor';
import { DeltaCalculator, LegState } from '../lighter/deltaCalculator';

interface LighterLegState {
  open: boolean;
  side: 'long' | 'short' | 'none';
  sizeEth: number;
  entryPrice: number;
  openedAt: Date | null;
  clientOrderIndex: number | null;
}

export interface DeltaNeutralConfig {
  lighterAccountIndex:        number;
  lighterApiKeyIndex:         number;
  lighterApiPrivateKey:       string;
  lighterMarketIndex:         number;
  fundingSpreadThreshold:     number;
  fundingSpreadExitThreshold: number;
  deltaRebalanceThresholdPct: number;
  lighterSizeEth:             number;
  maxHoldMinutes:             number;
  fundingPollMs:              number;
}

export class DeltaNeutralBot extends TradingBot {
  private dnConfig:       DeltaNeutralConfig;
  private lighterClient:  LighterClient;
  private lighterMonitor: LighterPriceMonitor;
  private deltaCalc:      DeltaCalculator;

  private lighterLeg: LighterLegState = {
    open: false, side: 'none', sizeEth: 0,
    entryPrice: 0, openedAt: null, clientOrderIndex: null,
  };

  private lighterPrice       = 0;
  private lighterFunding     = 0;
  private riseFunding        = 0;
  private totalFundingEarned = 0;
  private pairDirection: 'rise-long' | 'rise-short' | null = null;
  private currentSizeEth: number = 0;
  private currentHoldMinutes: number = 0;
  private currentRiseSteps: number = 0;

  private fundingPollTimer: NodeJS.Timeout | null = null;
  private sessionTrades = 0;
  private sessionPnl    = 0;
  private cooldownUntil: number = 0;
  private readonly COOLDOWN_MS = 2 * 60 * 1000; // 2 минуты
  private riseEntryPrice: number = 0;
  private riseSide: string = 'none';
  private riseSizeEth: number = 0;
  private pairOpenedAt:     Date | null = null;

  constructor(config: BotConfig, dnConfig: DeltaNeutralConfig) {
    super(config);
    this.dnConfig = dnConfig;

    this.lighterClient = new LighterClient({
      accountIndex:  dnConfig.lighterAccountIndex,
      apiKeyIndex:   dnConfig.lighterApiKeyIndex,
      apiPrivateKey: dnConfig.lighterApiPrivateKey,
    });

    this.lighterMonitor = new LighterPriceMonitor(
      dnConfig.lighterMarketIndex,
      (price) => { this.lighterPrice = price; },
      (rate)  => { this.lighterFunding = rate; }
    );

    this.deltaCalc = new DeltaCalculator(dnConfig.deltaRebalanceThresholdPct);
  }

  public async start(): Promise<void> {
    logger.info('═══════════════════════════════════════════════════');
    logger.info('     Delta-Neutral Bot  (Rise + Lighter, обе стороны)');
    logger.info('═══════════════════════════════════════════════════');
    logger.info(`Rise market:     ${this.config.marketId}`);
    logger.info(`Lighter market:  ${this.dnConfig.lighterMarketIndex}`);
    logger.info(`Size:            ${this.dnConfig.lighterSizeEth} ETH`);
    logger.info(`Порог входа:     ±${this.dnConfig.fundingSpreadThreshold}%`);
    logger.info(`Порог выхода:    ±${this.dnConfig.fundingSpreadExitThreshold}%`);
    logger.info(`Delta rebalance: ${this.dnConfig.deltaRebalanceThresholdPct}%`);
    logger.info(`Max hold:        ${this.dnConfig.maxHoldMinutes} мин`);

    await this.lighterClient.init();
    await this.lighterMonitor.start();
    this.startFundingPoll();

    // Синхронизируем состояние с биржей при старте
    await this.posManager.syncWithExchange(this.config.marketId);

    return super.start();
  }

  public async stop(): Promise<void> {
    if (this.fundingPollTimer) clearInterval(this.fundingPollTimer);
    this.lighterMonitor.stop();
    if (this.lighterLeg.open) {
      logger.warn('Emergency closing Lighter leg on shutdown...');
      await this.closeLighterLeg('shutdown');
    }
    return super.stop();
  }

  // Rise LONG + Lighter SHORT — когда Rise funding > Lighter funding
  protected shouldOpenLong(price: number): boolean {
    if (this.lighterPrice === 0) return false;
    if (Date.now() < this.cooldownUntil) {
      const remaining = ((this.cooldownUntil - Date.now()) / 1000).toFixed(0);
      logger.debug(`⏸ Cooldown активен, осталось ${remaining}s`);
      return false;
    }
    const spread = this.getFundingSpread();
    if (spread > this.dnConfig.fundingSpreadThreshold) {
      logger.info(`📡 СИГНАЛ LONG | Rise funding выше | спред=+${(spread * 100).toFixed(6)}% | ETH=${price}`);
      this.pairDirection = 'rise-long';
      this.randomizeTradeParams(price);
      // Обновляем размер Rise позиции
      this.config.positionSizeSteps = this.currentRiseSteps;
      return true;
    }
    return false;
  }

  // Rise SHORT + Lighter LONG — когда Lighter funding > Rise funding
  protected shouldOpenShort(price: number): boolean {
    if (this.lighterPrice === 0) return false;
    if (Date.now() < this.cooldownUntil) {
      const remaining = ((this.cooldownUntil - Date.now()) / 1000).toFixed(0);
      logger.debug(`⏸ Cooldown активен, осталось ${remaining}s`);
      return false;
    }
    const spread = this.getFundingSpread();
    if (spread < -this.dnConfig.fundingSpreadThreshold) {
      logger.info(`📡 СИГНАЛ SHORT | Lighter funding выше | спред=${(spread * 100).toFixed(6)}% | ETH=${price}`);
      this.pairDirection = 'rise-short';
      this.randomizeTradeParams(price);
      // Обновляем размер Rise позиции
      this.config.positionSizeSteps = this.currentRiseSteps;
      return true;
    }
    return false;
  }

  private randomizeTradeParams(currentPrice: number): void {
    // Случайный размер от $100 до $600
    const minUsd = parseFloat(process.env.MIN_USD ?? "489");
    const maxUsd = parseFloat(process.env.MAX_USD ?? "1243");
    const randomUsd = minUsd + Math.random() * (maxUsd - minUsd);
    this.currentSizeEth = parseFloat((randomUsd / currentPrice).toFixed(4));
    // Rise: 1 step = 0.001 единиц токена (универсально для любого токена)
    // $209 / $82 = 2.5411 SOL → steps = round(2.5411 / 0.001) = 2541
    this.currentRiseSteps = Math.round(this.currentSizeEth / 0.001);

    // Случайное время от 8 до 30 минут
    this.currentHoldMinutes = Math.floor(8 + Math.random() * (30 - 8));

    logger.info(`🎲 Рандом | размер=$${randomUsd.toFixed(0)} (${this.currentSizeEth} ETH / ${this.currentRiseSteps} steps) | время=${this.currentHoldMinutes} мин`);
  }

  protected onPositionOpened(): void {
    this.pairOpenedAt = new Date();
    // Сохраняем данные Rise позиции для расчёта PnL
    const risePos = this.posManager.getActivePosition();
    if (risePos) {
      this.riseEntryPrice = risePos.entryPrice;
      this.riseSide = risePos.side;
      this.riseSizeEth = risePos.size * 0.001;
    }
    const openTime = this.pairOpenedAt.toLocaleTimeString();
    const spread = this.getFundingSpread();
    const direction = this.pairDirection === 'rise-long'
      ? 'Rise LONG  + Lighter SHORT'
      : 'Rise SHORT + Lighter LONG ';

    logger.info('──────────────────────────────────────────────');
    logger.info(`🟢 СДЕЛКА ОТКРЫТА`);
    logger.info(`   Время открытия : ${openTime}`);
    logger.info(`   Направление    : ${direction}`);
    logger.info(`   Rise цена      : ${this.currentPrice.toFixed(2)} USDC`);
    logger.info(`   Lighter цена   : ${this.lighterPrice.toFixed(2)} USDC`);
    logger.info(`   Размер         : ${this.currentSizeEth} ETH`);
    logger.info(`   Время удержания: ${this.currentHoldMinutes} мин`);
    logger.info(`   Funding спред  : ${(spread * 100).toFixed(6)}%`);
    logger.info('──────────────────────────────────────────────');
    this.totalFundingEarned = 0;

    // Открываем Lighter ногу в противоположную сторону от Rise
    const lighterSide = this.pairDirection === 'rise-long' ? 'short' : 'long';
    this.openLighterLeg(lighterSide).then(async () => {
      // Проверяем что Rise позиция реально открыта
      await new Promise(r => setTimeout(r, 2000));
      if (!this.posManager.hasOpenPosition()) {
        logger.warn('⚠️  Rise позиция не подтверждена — закрываем Lighter!');
        await this.closeLighterLeg('rise-not-confirmed').catch((e) =>
          logger.error(`Emergency Lighter close failed: ${e}`)
        );
      }
    }).catch((err) => {
      logger.error(`Failed to open Lighter leg: ${err}`);
      logger.warn('Closing Rise leg to avoid naked exposure!');
      this.posManager.closePosition('lighter-leg-failed').catch((e) =>
        logger.error(`Emergency Rise close failed: ${e}`)
      );
    });
  }

  protected onPositionClosed(): void {
    const closeTime = new Date().toLocaleTimeString();
    const durationMin = this.pairOpenedAt
      ? ((Date.now() - this.pairOpenedAt.getTime()) / 60_000).toFixed(1)
      : '?';

    const closePrice = this.posManager.getLastClosePrice();
    const risePnl    = this.calcRisePnl(closePrice);
    const lighterPnl = this.calcLighterPnl(this.lighterPrice);
    const totalPnl   = risePnl + lighterPnl + this.totalFundingEarned;

    logger.info('──────────────────────────────────────────────');
    logger.info(`🔴 СДЕЛКА ЗАКРЫТА`);
    logger.info(`   Время закрытия : ${closeTime}`);
    logger.info(`   Длительность   : ${durationMin} мин`);
    logger.info(`   Rise PnL       : $${risePnl.toFixed(4)}`);
    logger.info(`   Lighter PnL    : $${lighterPnl.toFixed(4)}`);
    logger.info(`   Funding earned : $${this.totalFundingEarned.toFixed(4)}`);
    logger.info(`   Итого PnL      : $${totalPnl.toFixed(4)}`);
    logger.info('──────────────────────────────────────────────');

    this.sessionTrades += 1;
    this.sessionPnl    += totalPnl;
    logger.info(`📈 Сессия: ${this.sessionTrades} сделок | Суммарный PnL: $${this.sessionPnl.toFixed(4)}`);
    this.cooldownUntil = Date.now() + this.COOLDOWN_MS;
    logger.info(`⏸ Cooldown 2 мин перед следующей сделкой...`);

    this.pairOpenedAt = null;
    this.pairDirection = null;
    this.closeLighterLeg('rise-closed').catch((err) =>
      logger.error(`Failed to close Lighter leg: ${err}`)
    );
  }

  protected async onPositionCheck(): Promise<boolean> {
    // 1. Стоп-лосс / тейк-профит для всей пары
    const risePnl    = this.calcRisePnl();
    const lighterPnl = this.calcLighterPnl(this.lighterPrice);
    const totalPnl   = risePnl + lighterPnl;
    const grossExp   = this.currentSizeEth * this.lighterPrice * 2;
    const pnlPct     = grossExp > 0 ? (totalPnl / grossExp) * 100 : 0;
    const slPct      = parseFloat(process.env.PAIR_STOP_LOSS_PCT ?? '10');
    const tpPct      = parseFloat(process.env.PAIR_TAKE_PROFIT_PCT ?? '5');

    logger.debug(`💰 Pair PnL: $${totalPnl.toFixed(4)} (${pnlPct.toFixed(2)}%) | SL=-${slPct}% TP=+${tpPct}%`);

    if (pnlPct < -slPct) {
      logger.warn(`🛑 СТОП-ЛОСС ПАРЫ | PnL=${totalPnl.toFixed(4)} (${pnlPct.toFixed(2)}%) → закрываем обе ноги`);
      return true;
    }

    if (pnlPct > tpPct) {
      logger.info(`🎯 ТЕЙК-ПРОФИТ ПАРЫ | PnL=${totalPnl.toFixed(4)} (${pnlPct.toFixed(2)}%) → закрываем обе ноги`);
      return true;
    }

    // 2. Таймер
    if (this.pairOpenedAt) {
      const minutesHeld = (Date.now() - this.pairOpenedAt.getTime()) / 60_000;
      if (minutesHeld >= this.currentHoldMinutes) {
        logger.info(`⏱ Max hold reached (${minutesHeld.toFixed(1)} мин) → closing pair`);
        return true;
      }
    }

    // 3. Funding спред схлопнулся
    const spread = Math.abs(this.getFundingSpread());
    if (spread < this.dnConfig.fundingSpreadExitThreshold) {
      logger.info(`📉 Funding спред схлопнулся (${(spread * 100).toFixed(6)}%) → closing pair`);
      return true;
    }

    // await this.checkAndRebalanceDelta(); // отключено
    return false;
  }

  private async openLighterLeg(side: 'long' | 'short'): Promise<void> {
    if (this.lighterLeg.open) { logger.warn('Lighter leg already open'); return; }

    const midPrice = this.lighterPrice;
    if (midPrice === 0) throw new Error('No Lighter price available');

    let result;
    if (side === 'short') {
      result = await this.lighterClient.marketShort(
        this.dnConfig.lighterMarketIndex,
        this.currentSizeEth,
        midPrice * 0.995
      );
    } else {
      result = await this.lighterClient.marketLong(
        this.dnConfig.lighterMarketIndex,
        this.currentSizeEth,
        midPrice * 1.05
      );
    }

    this.lighterLeg = {
      open: true, side,
      sizeEth: this.currentSizeEth,
      entryPrice: midPrice,
      openedAt: new Date(),
      clientOrderIndex: result.clientOrderIndex,
    };

    logger.info(`Lighter leg opened | ${side.toUpperCase()} ${this.currentSizeEth} ETH @ ≈${midPrice} | txHash=${result.txHash}`);
  }

  private async closeLighterLeg(reason: string): Promise<void> {
    if (!this.lighterLeg.open) { logger.warn('closeLighterLeg: no open leg'); return; }
    logger.info(`Closing Lighter leg | reason=${reason}`);
    try {
      await this.lighterClient.closePosition(
        this.dnConfig.lighterMarketIndex,
        this.lighterLeg.side,
        this.lighterLeg.sizeEth,
        this.lighterPrice
      );
      const pnl = this.calcLighterPnl(this.lighterPrice);
      logger.info(`Lighter leg closed | closePrice=${this.lighterPrice} | PnL≈$${pnl.toFixed(4)}`);
    } catch (err) {
      logger.error(`Lighter leg close failed: ${err}`);
      throw err;
    } finally {
      this.lighterLeg = { open: false, side: 'none', sizeEth: 0, entryPrice: 0, openedAt: null, clientOrderIndex: null };
    }
  }

  private async checkAndRebalanceDelta(): Promise<void> {
    if (!this.lighterLeg.open || !this.posManager.hasOpenPosition()) return;
    // Не ребалансируем если Lighter позиция ещё не открылась реально
    if (this.lighterLeg.sizeEth <= 0) {
      logger.warn('Rebalance skipped: Lighter position size is 0');
      return;
    }
    const risePos = this.posManager.getActivePosition();
    if (!risePos) return;

    const riseLeg: LegState = {
      side: risePos.side, sizeEth: risePos.size * 0.001,
      entryPrice: risePos.entryPrice, currentPrice: this.currentPrice,
    };
    const lighterLeg: LegState = {
      side: this.lighterLeg.side, sizeEth: this.lighterLeg.sizeEth,
      entryPrice: this.lighterLeg.entryPrice, currentPrice: this.lighterPrice,
    };

    const report = this.deltaCalc.compute(riseLeg, lighterLeg);
    this.deltaCalc.logReport(report);

    if (!report.isNeutral) {
      const adjustEth = this.deltaCalc.rebalanceSize(report, this.lighterPrice);
      await this.rebalanceLighterLeg(adjustEth);
    }
  }

  private async rebalanceLighterLeg(adjustEth: number): Promise<void> {
    if (Math.abs(adjustEth) < 0.001) return;
    // Ограничение: ребаланс не более 20% от текущего размера за один раз
    const maxAdjust = this.currentSizeEth * 0.2;
    if (Math.abs(adjustEth) > maxAdjust) {
      logger.warn(`Rebalance capped: ${adjustEth.toFixed(4)} → ${maxAdjust.toFixed(4)} ETH (max 20%)`);
      adjustEth = adjustEth > 0 ? maxAdjust : -maxAdjust;
    }
    const midPrice = this.lighterPrice;
    logger.info(`⚖️  Rebalancing | adjust=${adjustEth.toFixed(4)} ETH`);
    try {
      if (adjustEth > 0) {
        await this.lighterClient.marketShort(this.dnConfig.lighterMarketIndex, Math.abs(adjustEth), midPrice * 0.995);
        this.lighterLeg.sizeEth += Math.abs(adjustEth);
      } else {
        await this.lighterClient.marketLong(this.dnConfig.lighterMarketIndex, Math.abs(adjustEth), midPrice * 1.05);
        this.lighterLeg.sizeEth = Math.max(0, this.lighterLeg.sizeEth - Math.abs(adjustEth));
      }
      logger.info(`Rebalance done | Lighter ${this.lighterLeg.side} now ${this.lighterLeg.sizeEth.toFixed(4)} ETH`);
    } catch (err) {
      logger.error(`Rebalance failed: ${err}`);
    }
  }

  private startFundingPoll(): void {
    this.pollRiseFunding();
    this.fundingPollTimer = setInterval(() => {
      this.pollRiseFunding().then(() => {
        const spread = this.getFundingSpread();
        const spreadPct = (spread * 100).toFixed(6);
        const direction = spread > 0 ? '↑ Rise>Lighter' : '↓ Lighter>Rise';
        const position = this.lighterLeg.open ? `OPEN (${this.pairDirection})` : 'waiting';
        let durationStr = '';
        if (this.pairOpenedAt) {
          const min = ((Date.now() - this.pairOpenedAt.getTime()) / 60_000).toFixed(1);
          durationStr = ` | активна ${min} мин`;
          const fundingPerPoll = Math.abs(spread) * this.dnConfig.lighterSizeEth * this.lighterPrice;
          this.totalFundingEarned += fundingPerPoll;
        }
        logger.info(
          `📊 Rise=${(this.riseFunding * 100).toFixed(6)}% | ` +
          `Lighter=${this.lighterFunding.toFixed(6)}% | ` +
          `спред=${spreadPct}% ${direction} | ` +
          `ETH=${this.lighterPrice.toFixed(2)} | ` +
          `${position}` +
          durationStr
        );
      });
    }, this.dnConfig.fundingPollMs);
  }

  private async pollRiseFunding(): Promise<void> {
    try {
      const res = await fetch('https://api.rise.trade/v1/markets');
      if (!res.ok) return;
      const data: any = await res.json();
      const markets = data?.data?.markets ?? [];
      const market = markets.find((m: any) => String(m.market_id) === String(this.config.marketId));
      if (market) {
        this.riseFunding = parseFloat(market.current_funding_rate ?? '0');
      }
    } catch (err) {
      logger.warn(`Rise funding poll failed: ${err}`);
    }
  }

  private getFundingSpread(): number {
    return this.riseFunding - (this.lighterFunding / 100);
  }

  private calcRisePnl(closePrice?: number): number {
    // Используем closePrice если передан (при закрытии), иначе currentPrice
    const price = closePrice ?? this.currentPrice;
    // Пробуем получить активную позицию
    const risePos = this.posManager.getActivePosition();
    if (risePos) {
      const diff = price - risePos.entryPrice;
      return risePos.side === 'long' ? diff * risePos.size * 0.001 : -diff * risePos.size * 0.001;
    }
    // Позиция уже закрыта — используем сохранённые данные
    if (this.riseEntryPrice === 0) return 0;
    const diff = price - this.riseEntryPrice;
    return this.riseSide === 'long' ? diff * this.riseSizeEth : -diff * this.riseSizeEth;
  }

  private calcLighterPnl(closePrice: number): number {
    if (!this.lighterLeg.entryPrice || this.lighterLeg.sizeEth === 0) return 0;
    return this.lighterLeg.side === 'short'
      ? (this.lighterLeg.entryPrice - closePrice) * this.lighterLeg.sizeEth
      : (closePrice - this.lighterLeg.entryPrice) * this.lighterLeg.sizeEth;
  }
}
