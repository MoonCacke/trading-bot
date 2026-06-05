import dotenv from 'dotenv';
dotenv.config();

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

export interface BotConfig {
  accountAddress: string;
  signerPrivateKey: string;
  marketId: number;
  positionSizeSteps: number;
  stopLossPct: number;
  takeProfitPct: number;
  monitorIntervalMs: number;
}

export function loadConfig(): BotConfig {
  return {
    accountAddress: requireEnv('ACCOUNT_ADDRESS'),
    signerPrivateKey: requireEnv('SIGNER_PRIVATE_KEY'),
    marketId: optInt('MARKET_ID', 2),
    positionSizeSteps: optInt('POSITION_SIZE_STEPS', 250),
    stopLossPct: optFloat('STOP_LOSS_PCT', 2),
    takeProfitPct: optFloat('TAKE_PROFIT_PCT', 2),
    monitorIntervalMs: optInt('MONITOR_INTERVAL_MS', 10000),
  };
}
