import express from 'express';
import cors from 'cors';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';

const app = express();
app.use(cors());
app.use(express.json());

let botProcess: ChildProcess | null = null;
let botPid: number | null = null;
let botStatus = 'stopped';
let botLogs: string[] = [];
let selectedPair = 'ETH';

const SESSION_FILE = path.join(__dirname, '..', 'session_start.json');
const LOG_FILE = path.join(__dirname, '..', 'logs', 'combined.log');

function loadSessionStart(): number {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8')).start;
  } catch { return 0; }
}

function saveSessionStart(): void {
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ start: Date.now() }));
}

function getSessionStats(): { pnl: number; trades: number } {
  const start = loadSessionStart();
  if (!start) return { pnl: 0, trades: 0 };
  let pnl = 0, trades = 0;
  try {
    const stat = fs.statSync(LOG_FILE);
    const readSize = Math.min(stat.size, 3 * 1024 * 1024); // последние 3 МБ
    const buf = Buffer.alloc(readSize);
    const fd = fs.openSync(LOG_FILE, 'r');
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);
    const lines = buf.toString('utf-8').split('\n');
    for (const raw of lines) {
      const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
      const m = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\].*Итого PnL\s*:\s*\$(-?[0-9.]+)/);
      if (m) {
        const ts = new Date(m[1].replace(' ', 'T')).getTime();
        if (ts >= start) {
          pnl += parseFloat(m[2]);
          trades += 1;
        }
      }
    }
  } catch {}
  return { pnl, trades };
}

let botSettings = {
  minUsd: 489,
  maxUsd: 1243,
};

function cleanLog(line: string): string {
  return line.replace(/\x1b\[[\d]+m/g, '').trim();
}

app.post('/api/bot/start', (req, res) => {
  if (botProcess) {
    return res.json({ ok: false, message: 'Бот уже запущен' });
  }
  const pair = req.body.pair || '1';
  selectedPair = req.body.pairName || 'ETH';

  botProcess = spawn('npx', ['ts-node', 'src/indexDeltaNeutral.ts'], {
    cwd: path.join(__dirname, '..'),
    detached: true,
    env: {
      ...process.env,
      SELECTED_PAIR: pair,
      MIN_USD: String(botSettings.minUsd),
      MAX_USD: String(botSettings.maxUsd),
    },
  });

  botPid = botProcess.pid ?? null;

  botProcess.stdout?.on('data', (data) => {
    const line = cleanLog(data.toString());
    if (line) {
      botLogs.push(line);
      if (botLogs.length > 100) botLogs.shift();
    }
  });

  botProcess.stderr?.on('data', (data) => {
    const line = cleanLog(data.toString());
    if (line) { botLogs.push(line); if (botLogs.length > 100) botLogs.shift(); }
  });

  botProcess.on('close', () => {
    botStatus = 'stopped';
    botProcess = null;
    botPid = null;
  });

  saveSessionStart();
  botStatus = 'running';
  res.json({ ok: true, message: `Бот запущен | пара: ${selectedPair}` });
});

app.post('/api/bot/stop', (req, res) => {
  if (!botProcess || !botPid) {
    return res.json({ ok: false, message: 'Бот не запущен' });
  }

  botStatus = 'stopping';
  botLogs.push('Закрываем позиции перед остановкой...');

  try {
    process.kill(-botPid, 'SIGINT');
  } catch (e) {
    botProcess.kill('SIGINT');
  }

  const timeout = setTimeout(() => {
    if (botProcess && botPid) {
      botLogs.push('Принудительная остановка...');
      try { process.kill(-botPid!, 'SIGKILL'); } catch (e) { botProcess?.kill('SIGKILL'); }
      botProcess = null;
      botPid = null;
      botStatus = 'stopped';
    }
  }, 60000);

  botProcess.on('close', () => {
    clearTimeout(timeout);
    botLogs.push('Позиции закрыты, бот остановлен');
    botStatus = 'stopped';
    botProcess = null;
    botPid = null;
  });

  res.json({ ok: true, message: 'Закрываем позиции, подождите...' });
});

app.get('/api/bot/status', (req, res) => {
  res.json({
    status: botStatus,
    pair: selectedPair,
    logs: botLogs.slice(-20),
    settings: botSettings,
    sessionPnl: parseFloat(getSessionStats().pnl.toFixed(4)),
    sessionTrades: getSessionStats().trades,
  });
});

app.post('/api/bot/settings', (req, res) => {
  const { minUsd, maxUsd } = req.body;
  if (minUsd) botSettings.minUsd = Number(minUsd);
  if (maxUsd) botSettings.maxUsd = Number(maxUsd);
  res.json({ ok: true, settings: botSettings });
});

// ───── Ручное управление позицией ─────
let manualBusy = false;

function runManualScript(args: string[]): Promise<any> {
  return new Promise((resolve) => {
    const proc = spawn('npx', ['ts-node', 'src/manualPosition.ts', ...args], {
      cwd: path.join(__dirname, '..'),
    });
    let stdout = '';
    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => {
      const line = cleanLog(d.toString());
      if (line) botLogs.push(line);
    });
    proc.on('close', () => {
      try {
        const lines = stdout.trim().split('\n');
        resolve(JSON.parse(lines[lines.length - 1]));
      } catch {
        resolve({ ok: false, message: `Не удалось распарсить ответ: ${stdout.slice(-200)}` });
      }
    });
    proc.on('error', (err) => resolve({ ok: false, message: String(err) }));
  });
}

app.post('/api/position/open', async (req, res) => {
  if (manualBusy) return res.json({ ok: false, message: 'Операция уже выполняется' });
  manualBusy = true;
  const sizeUsd = Number(req.body.sizeUsd) || 300;
  botLogs.push(`🖐 Ручное открытие позиции $${sizeUsd}...`);
  const result = await runManualScript(['open', String(sizeUsd)]);
  botLogs.push(`🖐 ${result.message}`);
  manualBusy = false;
  res.json(result);
});

app.post('/api/position/close', async (req, res) => {
  if (manualBusy) return res.json({ ok: false, message: 'Операция уже выполняется' });
  manualBusy = true;
  botLogs.push('🖐 Ручное закрытие позиции...');
  const result = await runManualScript(['close']);
  botLogs.push(`🖐 ${result.message}`);
  manualBusy = false;
  res.json(result);
});

app.get('/api/position/status', async (req, res) => {
  const result = await runManualScript(['status']);
  res.json(result);
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`API сервер запущен на порту ${PORT}`);
});
