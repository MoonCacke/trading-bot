// Автопатч risex-client: добавляет reduce_only=true при закрытии SHORT позиции
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'node_modules', 'risex-client', 'dist', 'cjs', 'index.js');

const BROKEN = 'return isLong ? this.marketSell(marketId, sizeSteps, true) : this.marketBuy(marketId, sizeSteps);';
const FIXED  = 'return isLong ? this.marketSell(marketId, sizeSteps, true) : this.marketBuy(marketId, sizeSteps, true);';

try {
  let content = fs.readFileSync(FILE, 'utf-8');
  if (content.includes(FIXED)) {
    console.log('[patch-sdk] Уже пропатчено ✅');
  } else if (content.includes(BROKEN)) {
    content = content.replace(BROKEN, FIXED);
    fs.writeFileSync(FILE, content);
    console.log('[patch-sdk] Патч применён ✅');
  } else {
    console.log('[patch-sdk] ⚠️ Строка не найдена — проверь версию SDK вручную!');
    process.exit(1);
  }
} catch (err) {
  console.log('[patch-sdk] Ошибка: ' + err.message);
  process.exit(1);
}
