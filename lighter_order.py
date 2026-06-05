#!/usr/bin/env python3.11
import asyncio
import sys
import json
import os
import lighter

BASE_URL = "https://mainnet.zklighter.elliot.ai"

def load_env():
    env = {}
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
    try:
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, v = line.split('=', 1)
                    env[k.strip()] = v.strip()
    except Exception as e:
        sys.stderr.write(f"ENV load error: {e}\n")
    return env

async def main():
    env = load_env()
    ACCOUNT_INDEX = int(env.get('LIGHTER_ACCOUNT_INDEX', '0'))
    API_KEY_INDEX = int(env.get('LIGHTER_API_KEY_INDEX', '2'))
    API_PRIV_KEY  = env.get('LIGHTER_API_PRIVATE_KEY', '')

    sys.stderr.write(f"[order] account={ACCOUNT_INDEX} api_key={API_KEY_INDEX} cwd={os.getcwd()}\n")

    p = json.loads(sys.stdin.read())
    sys.stderr.write(f"[order] params={p}\n")

    client = lighter.SignerClient(
        url=BASE_URL,
        api_private_keys={API_KEY_INDEX: API_PRIV_KEY},
        account_index=ACCOUNT_INDEX,
    )

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

    sys.stderr.write(f"[order] err={err} tx_hash={tx_hash}\n")

    if err:
        print(json.dumps({"error": str(err)}))
        sys.exit(1)

    if hasattr(tx_hash, 'tx_hash'):
        tx_hash_str = tx_hash.tx_hash
    elif isinstance(tx_hash, bytes):
        tx_hash_str = tx_hash.hex()
    else:
        tx_hash_str = str(tx_hash)

    print(json.dumps({"tx_hash": tx_hash_str, "ok": True}))

asyncio.run(main())
