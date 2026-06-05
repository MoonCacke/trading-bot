#!/usr/bin/env python3
import asyncio
import json
from aiohttp import web
import lighter

BASE_URL = "https://mainnet.zklighter.elliot.ai"

def load_env():
    env = {}
    try:
        with open('.env') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, v = line.split('=', 1)
                    env[k.strip()] = v.strip()
    except:
        pass
    return env

env = load_env()
ACCOUNT_INDEX = int(env.get('LIGHTER_ACCOUNT_INDEX', '0'))
API_KEY_INDEX = int(env.get('LIGHTER_API_KEY_INDEX', '2'))
API_PRIV_KEY  = env.get('LIGHTER_API_PRIVATE_KEY', '')

print(f"[LighterSigner] account={ACCOUNT_INDEX} api_key={API_KEY_INDEX}")

client = None

async def init_client():
    global client
    client = lighter.SignerClient(
        url=BASE_URL,
        api_private_keys={API_KEY_INDEX: API_PRIV_KEY},
        account_index=ACCOUNT_INDEX,
    )
    print(f"[LighterSigner] Client initialized")

async def health(request):
    return web.Response(text="ok")

async def handle_order(request):
    p = await request.json()
    action = p.get('action', 'create_order')
    try:
        if action == 'create_order':
            print(f"[LighterSigner] Sending: market={p['market_index']} base_amount={p['base_amount']} price={p['price']} is_ask={p['is_ask']}")
            tx, tx_hash, err = await client.create_order(
                market_index       = p['market_index'],
                client_order_index = p['client_order_index'],
                base_amount        = p['base_amount'],
                price              = p['price'],
                is_ask             = p['is_ask'],
                order_type         = p['order_type'],
                time_in_force      = p['time_in_force'],
                reduce_only        = p['reduce_only'],
                order_expiry       = client.DEFAULT_IOC_EXPIRY,
            )
            if err:
                raise Exception(f"create_order error: {err}")
            if hasattr(tx_hash, 'tx_hash'):
                tx_hash_str = tx_hash.tx_hash
            elif isinstance(tx_hash, bytes):
                tx_hash_str = tx_hash.hex()
            else:
                tx_hash_str = str(tx_hash)
            print(f"[LighterSigner] Order OK | tx_hash={tx_hash_str}")
            return web.json_response({"tx_hash": tx_hash_str, "ok": True})
        raise Exception(f"Unknown action: {action}")
    except Exception as e:
        print(f"[LighterSigner] Error: {e}")
        return web.json_response({"error": str(e)}, status=500)

async def main():
    await init_client()
    app = web.Application()
    app.router.add_get('/health', health)
    app.router.add_post('/', handle_order)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 7777)
    await site.start()
    print(f"[LighterSigner] Running on http://127.0.0.1:7777")
    await asyncio.sleep(float('inf'))

asyncio.run(main())
