import { useState, useEffect, useRef } from 'react'

const API = 'https://yuritb.ru/api'

const PAIRS = [
  { id: '1', name: 'ETH' },
  { id: '2', name: 'BTC' },
  { id: '3', name: 'SOL' },
  { id: '4', name: 'BNB' },
  { id: '5', name: 'HYPE' },
]

export default function App() {
  const [status, setStatus] = useState('stopped')
  const [pair, setPair] = useState('ETH')
  const [selectedPair, setSelectedPair] = useState('1')
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(false)
  const [minUsd, setMinUsd] = useState(489)
  const [maxUsd, setMaxUsd] = useState(1243)
  const [saved, setSaved] = useState(false)
  const [sessionPnl, setSessionPnl] = useState(0)
  const [sessionTrades, setSessionTrades] = useState(0)
  const isEditingSettings = useRef(false)

  useEffect(() => {
    fetchStatus()
    const interval = setInterval(fetchStatus, 3000)
    return () => clearInterval(interval)
  }, [])

  async function fetchStatus() {
    try {
      const res = await fetch(`${API}/bot/status`)
      const data = await res.json()
      setStatus(data.status)
      setPair(data.pair)
      setLogs(data.logs || [])
      // Обновляем настройки только если пользователь не редактирует
      if (data.settings && !isEditingSettings.current) {
        setMinUsd(data.settings.minUsd)
        setMaxUsd(data.settings.maxUsd)
      }
    } catch (e) {}
  }

  async function startBot() {
    setLoading(true)
    const pairName = PAIRS.find(p => p.id === selectedPair)?.name || 'ETH'
    await fetch(`${API}/bot/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pair: selectedPair, pairName }),
    })
    await fetchStatus()
    setLoading(false)
  }

  async function stopBot() {
    setLoading(true)
    await fetch(`${API}/bot/stop`, { method: 'POST' })
    await fetchStatus()
    setLoading(false)
  }

  async function saveSettings() {
    await fetch(`${API}/bot/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minUsd, maxUsd }),
    })
    isEditingSettings.current = false
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const isRunning = status === 'running'
  const isStopping = status === 'stopping'
  const statusColor = isRunning ? '#00ff88' : isStopping ? '#ffaa00' : '#ff4444'
  const statusText = isRunning ? `🟢 Работает | ${pair}` : isStopping ? '⏳ Закрываем позиции...' : '🔴 Остановлен'

  return (
    <div style={{ minHeight: '100vh', background: '#0f1117', color: '#fff', fontFamily: 'monospace', padding: '20px', maxWidth: '900px', margin: '0 auto' }}>
      <h1 style={{ color: '#00ff88', marginBottom: '30px' }}>⚡ Trading Bot Dashboard</h1>

      {/* Статус */}
      <div style={{ background: '#1a1d2e', borderRadius: '12px', padding: '20px', marginBottom: '20px' }}>
        <h2 style={{ marginBottom: '15px' }}>Статус бота</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '15px' }}>
          <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: statusColor }} />
          <span style={{ fontSize: '18px' }}>{statusText}</span>
        </div>

        {!isRunning && !isStopping && (
          <div style={{ marginBottom: '15px' }}>
            <label style={{ marginRight: '10px' }}>Торговая пара:</label>
            <select value={selectedPair} onChange={e => setSelectedPair(e.target.value)}
              style={{ background: '#2a2d3e', color: '#fff', border: '1px solid #444', borderRadius: '6px', padding: '6px 12px', fontSize: '14px' }}>
              {PAIRS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        )}

        <div style={{ display: 'flex', gap: '10px' }}>
          <button onClick={startBot} disabled={isRunning || isStopping || loading}
            style={{ background: (isRunning || isStopping) ? '#333' : '#00ff88', color: '#000', border: 'none', borderRadius: '8px', padding: '10px 24px', fontSize: '16px', cursor: (isRunning || isStopping) ? 'not-allowed' : 'pointer', fontWeight: 'bold' }}>
            ▶ Запустить
          </button>
          <button onClick={stopBot} disabled={!isRunning || isStopping || loading}
            style={{ background: (!isRunning || isStopping) ? '#333' : '#ff4444', color: '#fff', border: 'none', borderRadius: '8px', padding: '10px 24px', fontSize: '16px', cursor: (!isRunning || isStopping) ? 'not-allowed' : 'pointer', fontWeight: 'bold' }}>
            {isStopping ? '⏳ Закрываем...' : '⏹ Остановить'}
          </button>
        </div>

        {isStopping && (
          <div style={{ marginTop: '10px', color: '#ffaa00', fontSize: '13px' }}>
            ⚠️ Пожалуйста подождите — бот закрывает открытые позиции (до 30 сек)
          </div>
        )}
      </div>

      {/* PnL Статистика */}
      <div style={{ background: '#1a1d2e', borderRadius: '12px', padding: '20px', marginBottom: '20px' }}>
        <h2 style={{ marginBottom: '15px' }}>📈 Статистика сессии</h2>
        <div style={{ display: 'flex', gap: '30px', flexWrap: 'wrap' }}>
          <div>
            <div style={{ color: '#aaa', fontSize: '13px', marginBottom: '4px' }}>Сделок</div>
            <div style={{ fontSize: '28px', fontWeight: 'bold' }}>{sessionTrades}</div>
          </div>
          <div>
            <div style={{ color: '#aaa', fontSize: '13px', marginBottom: '4px' }}>PnL сессии</div>
            <div style={{ fontSize: '28px', fontWeight: 'bold', color: sessionPnl >= 0 ? '#00ff88' : '#ff4444' }}>
              {sessionPnl >= 0 ? '+' : ''}{sessionPnl.toFixed(2)}$
            </div>
          </div>
        </div>
      </div>

      {/* Настройки */}
      <div style={{ background: '#1a1d2e', borderRadius: '12px', padding: '20px', marginBottom: '20px' }}>
        <h2 style={{ marginBottom: '15px' }}>⚙️ Настройки размера позиции</h2>
        <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap', marginBottom: '15px' }}>
          <div>
            <label style={{ display: 'block', marginBottom: '6px', color: '#aaa' }}>Минимум ($)</label>
            <input type="number" value={minUsd}
              onFocus={() => { isEditingSettings.current = true }}
              onBlur={() => {}}
              onChange={e => setMinUsd(Number(e.target.value))}
              style={{ background: '#2a2d3e', color: '#fff', border: '1px solid #444', borderRadius: '6px', padding: '8px 12px', fontSize: '16px', width: '150px' }} />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '6px', color: '#aaa' }}>Максимум ($)</label>
            <input type="number" value={maxUsd}
              onFocus={() => { isEditingSettings.current = true }}
              onBlur={() => {}}
              onChange={e => setMaxUsd(Number(e.target.value))}
              style={{ background: '#2a2d3e', color: '#fff', border: '1px solid #444', borderRadius: '6px', padding: '8px 12px', fontSize: '16px', width: '150px' }} />
          </div>
        </div>
        <button onClick={saveSettings}
          style={{ background: saved ? '#00aa55' : '#4488ff', color: '#fff', border: 'none', borderRadius: '8px', padding: '10px 24px', fontSize: '14px', cursor: 'pointer', fontWeight: 'bold' }}>
          {saved ? '✅ Сохранено!' : '💾 Сохранить настройки'}
        </button>
      </div>

      {/* Логи */}
      <div style={{ background: '#1a1d2e', borderRadius: '12px', padding: '20px' }}>
        <h2 style={{ marginBottom: '15px' }}>📋 Логи</h2>
        <div style={{ background: '#0a0c14', borderRadius: '8px', padding: '15px', height: '300px', overflowY: 'auto', fontSize: '12px', lineHeight: '1.6' }}>
          {logs.length === 0 ? (
            <span style={{ color: '#666' }}>Логи появятся когда бот запустится...</span>
          ) : (
            logs.map((log, i) => (
              <div key={i} style={{ color: log.includes('ERROR') ? '#ff4444' : log.includes('СДЕЛКА') ? '#00ff88' : log.includes('⏳') ? '#ffaa00' : '#aaa' }}>
                {log}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
