import { logger } from '../logger';

export interface LegState {
  side: 'long' | 'short' | 'none';
  sizeEth: number;
  entryPrice: number;
  currentPrice: number;
}

export interface DeltaReport {
  riseNotionalUsd:    number;
  lighterNotionalUsd: number;
  netDeltaUsd:        number;
  netDeltaPct:        number;
  grossExposureUsd:   number;
  isNeutral:          boolean;
}

export class DeltaCalculator {
  private rebalanceThresholdPct: number;

  constructor(rebalanceThresholdPct = 1.0) {
    this.rebalanceThresholdPct = rebalanceThresholdPct;
  }

  compute(rise: LegState, lighter: LegState): DeltaReport {
    const riseSign    = rise.side    === 'long' ? 1 : rise.side    === 'short' ? -1 : 0;
    const lighterSign = lighter.side === 'long' ? 1 : lighter.side === 'short' ? -1 : 0;

    const riseNotional    = riseSign    * rise.sizeEth    * rise.currentPrice;
    const lighterNotional = lighterSign * lighter.sizeEth * lighter.currentPrice;

    const netDelta      = riseNotional + lighterNotional;
    const grossExposure = Math.abs(riseNotional) + Math.abs(lighterNotional);
    const netDeltaPct   = grossExposure > 0 ? (netDelta / grossExposure) * 100 : 0;
    const isNeutral     = Math.abs(netDeltaPct) < this.rebalanceThresholdPct;

    return {
      riseNotionalUsd:    riseNotional,
      lighterNotionalUsd: lighterNotional,
      netDeltaUsd:        netDelta,
      netDeltaPct,
      grossExposureUsd:   grossExposure,
      isNeutral,
    };
  }

  logReport(report: DeltaReport): void {
    const status = report.isNeutral ? '✅ NEUTRAL' : '⚠️  SKEWED';
    logger.debug(
      `${status} | ` +
      `riseNotional=$${report.riseNotionalUsd.toFixed(2)} | ` +
      `lighterNotional=$${report.lighterNotionalUsd.toFixed(2)} | ` +
      `netDelta=$${report.netDeltaUsd.toFixed(2)} (${report.netDeltaPct.toFixed(2)}%) | ` +
      `grossExposure=$${report.grossExposureUsd.toFixed(2)}`
    );
  }

  rebalanceSize(report: DeltaReport, currentPrice: number): number {
    if (report.isNeutral || currentPrice <= 0) return 0;
    const deltaEth = -report.netDeltaUsd / currentPrice;
    logger.info(`Rebalance needed: adjust Lighter by ${deltaEth.toFixed(4)} ETH`);
    return deltaEth;
  }
}
