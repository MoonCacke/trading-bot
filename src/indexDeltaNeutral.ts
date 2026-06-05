import 'dotenv/config';
import { loadConfig } from './config';
import { DeltaNeutralBot, DeltaNeutralConfig } from './strategies/deltaNeutralBot';
import { logger } from './logger';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v === '0x...') throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optFloat(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = parseFloat(v);
  if (isNaN(n)) throw new Error(`Invalid number for ${name}: ${v}`);
  return n;
}

function optInt(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = parseInt(v);
  if (isNaN(n)) throw new Error(`Invalid int for ${name}: ${v}`);
  return n;
}

// Маппинг торговых пар
const PAIRS: Record<string, { riseMarketId: number; lighterMarketId: number; symbol: string; sizeDecimals: number }> = {
  '1': { riseMarketId: 2,  lighterMarketId: 0,  symbol: 'ETH',  sizeDecimals: 4 },
  '2': { riseMarketId: 1,  lighterMarketId: 1,  symbol: 'BTC',  sizeDecimals: 5 },
  '3': { riseMarketId: 4,  lighterMarketId: 2,  symbol: 'SOL',  sizeDecimals: 3 },
  '4': { riseMarketId: 3,  lighterMarketId: 25, symbol: 'BNB',  sizeDecimals: 2 },
  '5': { riseMarketId: 5,  lighterMarketId: 24, symbol: 'HYPE', sizeDecimals: 2 },
};

async function selectPair(): Promise<{ riseMarketId: number; lighterMarketId: number; symbol: string }> {
  // Автовыбор из .env если задан SELECTED_PAIR
  const envPair = process.env.SELECTED_PAIR;
  if (envPair && PAIRS[envPair]) {
    const pair = PAIRS[envPair];
    console.log(`\n✅ Автовыбор из .env: ${pair.symbol} (SELECTED_PAIR=${envPair})\n`);
    return pair;
  }

  return new Promise((resolve) => {
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log('\n═══════════════════════════════════════');
    console.log('     RISEx Delta-Neutral Bot');
    console.log('     Выбери торговую пару:');
    console.log('═══════════════════════════════════════');
    console.log('  1. ETH');
    console.log('  2. BTC');
    console.log('  3. SOL');
    console.log('  4. BNB');
    console.log('  5. HYPE');
    console.log('═══════════════════════════════════════');

    readline.question('Введи номер (1-5): ', (answer: string) => {
      readline.close();
      const pair = PAIRS[answer.trim()];
      if (!pair) {
        console.log('Неверный выбор, используем ETH по умолчанию');
        resolve(PAIRS['1']);
      } else {
        console.log(`\n✅ Выбрано: ${pair.symbol}\n`);
        resolve(pair);
      }
    });
  });
}

async function main() {
  let riseConfig;
  try {
    riseConfig = loadConfig();
  } catch (err) {
    logger.error(`Rise config error: ${err}`);
    process.exit(1);
  }

  // Выбор пары
  const pair = await selectPair();
  riseConfig.marketId = pair.riseMarketId;

  let dnConfig: DeltaNeutralConfig;
  try {
    dnConfig = {
      lighterAccountIndex:        optInt('LIGHTER_ACCOUNT_INDEX', 0),
      lighterApiKeyIndex:         optInt('LIGHTER_API_KEY_INDEX', 2),
      lighterApiPrivateKey:       requireEnv('LIGHTER_API_PRIVATE_KEY'),
      lighterMarketIndex:         pair.lighterMarketId,
      fundingSpreadThreshold:     optFloat('FUNDING_SPREAD_THRESHOLD', 0.01),
      fundingSpreadExitThreshold: optFloat('FUNDING_SPREAD_EXIT_THRESHOLD', 0.005),
      deltaRebalanceThresholdPct: optFloat('DELTA_REBALANCE_THRESHOLD_PCT', 1.0),
      lighterSizeEth:             optFloat('LIGHTER_SIZE_ETH', 0.25),
      maxHoldMinutes:             optInt('MAX_HOLD_MINUTES', 480),
      fundingPollMs:              optInt('FUNDING_POLL_MS', 60_000),
    };
  } catch (err) {
    logger.error(`Delta-neutral config error: ${err}`);
    logger.error('Убедись что LIGHTER_API_PRIVATE_KEY заполнен в .env');
    process.exit(1);
  }

  const bot = new DeltaNeutralBot(riseConfig, dnConfig);

  try {
    await bot.start();
  } catch (err) {
    logger.error(`Bot failed to start: ${err}`);
    process.exit(1);
  }
}

main();
