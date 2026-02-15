#!/usr/bin/env python3
"""
LTD2 Smart Overlay - Data Fetcher

Fetches unit, wave, and legion data from the Legion TD 2 API
and generates JavaScript database files for the overlay.

Usage:
    python fetch-unit-data.py

Requires:
    - API key in ../.env file (LTD2_API_KEY=your_key)
    - Or set LTD2_API_KEY environment variable
"""

import json
import os
import sys
import time
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

API_BASE = "https://apiv2.legiontd2.com"
GAME_VERSION = "11.07.1"
REQUEST_DELAY = 0.3  # seconds between requests

SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent
DATA_DIR = PROJECT_DIR / "Data"
RAW_DIR = SCRIPT_DIR


def load_api_key():
    key = os.environ.get("LTD2_API_KEY")
    if key:
        return key

    env_file = PROJECT_DIR / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.startswith("LTD2_API_KEY="):
                return line.split("=", 1)[1].strip()

    print("ERROR: No API key found. Set LTD2_API_KEY env var or create .env file.")
    sys.exit(1)


def api_get(path, api_key):
    url = f"{API_BASE}{path}"
    req = Request(url, headers={"x-api-key": api_key})
    try:
        with urlopen(req) as resp:
            return json.loads(resp.read().decode())
    except HTTPError as e:
        if e.code == 404:
            return None
        raise


def fetch_paginated(path_template, api_key, page_size=50):
    all_data = []
    offset = 0
    while True:
        path = path_template.format(offset=offset, limit=page_size)
        data = api_get(path, api_key)
        if not data or not isinstance(data, list) or len(data) == 0:
            break
        all_data.extend(data)
        if len(data) < page_size:
            break
        offset += page_size
        time.sleep(REQUEST_DELAY)
    return all_data


def fetch_all_data(api_key):
    print(f"Fetching data from {API_BASE} (version {GAME_VERSION})...")

    print("  Fetching units...")
    units = api_get(f"/units/byVersion/{GAME_VERSION}?limit=300&offset=0&enabled=true", api_key)
    print(f"    -> {len(units)} units")
    time.sleep(REQUEST_DELAY)

    print("  Fetching waves...")
    waves = api_get("/info/waves/0/50", api_key)
    print(f"    -> {len(waves)} waves")
    time.sleep(REQUEST_DELAY)

    print("  Fetching legions...")
    legions = api_get("/info/legions/0/50", api_key)
    print(f"    -> {len(legions)} legions")
    time.sleep(REQUEST_DELAY)

    print("  Fetching abilities (paginated)...")
    abilities = fetch_paginated("/info/abilities/{offset}/{limit}", api_key)
    print(f"    -> {len(abilities)} abilities")

    return units, waves, legions, abilities


def save_raw(units, waves, legions, abilities):
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    for name, data in [("units", units), ("waves", waves), ("legions", legions), ("abilities", abilities)]:
        path = RAW_DIR / f"api_raw_{name}.json"
        path.write_text(json.dumps(data, indent=2))
        print(f"  Saved {path.name} ({len(data)} entries)")


def generate_units_js(raw_units):
    units = []
    for u in raw_units:
        units.append({
            "unitId": u.get("unitId", ""),
            "name": u.get("name", ""),
            "iconPath": u.get("iconPath", ""),
            "attackType": u.get("attackType", ""),
            "armorType": u.get("armorType", ""),
            "attackMode": u.get("attackMode", ""),
            "goldCost": u.get("goldCost", "0"),
            "totalValue": u.get("totalValue", "0"),
            "hp": u.get("hp", "0"),
            "dmgBase": u.get("dmgBase", "0"),
            "dps": u.get("dps", "0"),
            "attackSpeed": u.get("attackSpeed", "0"),
            "attackRange": u.get("attackRange", "0"),
            "moveSpeed": u.get("moveSpeed", "0"),
            "moveType": u.get("moveType", ""),
            "infoTier": u.get("infoTier", ""),
            "unitClass": u.get("unitClass", ""),  # Fighter, Creature, King, Mercenary, None
            "categoryClass": u.get("categoryClass", ""),  # Standard, Special, Passive
            "legionId": u.get("legionId", ""),
            "upgradesFrom": u.get("upgradesFrom", ""),
            "upgradesTo": u.get("upgradesTo", []),
            "flags": u.get("flags", ""),
            "description": u.get("description", ""),
        })

    header = (
        f"/**\n"
        f" * LTD2 Smart Overlay - Units Database\n"
        f" * Auto-generated from Legion TD 2 API v{GAME_VERSION}\n"
        f" * {len(units)} units\n"
        f" */\n"
    )
    js = header + "window.SmartOverlayUnits = " + json.dumps(units, indent=2) + ";\n"

    path = DATA_DIR / "units-database.js"
    path.write_text(js)
    print(f"  Generated {path.name} ({len(units)} units, {len(js)} bytes)")


def generate_waves_js(raw_waves, raw_units):
    unit_lookup = {u.get("unitId", ""): u for u in raw_units}

    waves = []
    for w in raw_waves:
        wave_unit = unit_lookup.get(w.get("waveUnitId", ""), {})
        waves.append({
            "wave": int(w.get("levelNum", "0")),
            "name": w.get("name", ""),
            "creature": w.get("name", ""),
            "amount": w.get("amount", "0"),
            "iconPath": w.get("iconPath", ""),
            "prepareTime": w.get("prepareTime", "0"),
            "totalReward": w.get("totalReward", "0"),
            "waveUnitId": w.get("waveUnitId", ""),
            "dmgType": wave_unit.get("attackType", ""),
            "defType": wave_unit.get("armorType", ""),
            "hp": wave_unit.get("hp", "0"),
            "dps": wave_unit.get("dps", "0"),
            "attackMode": wave_unit.get("attackMode", ""),
        })

    waves.sort(key=lambda x: x["wave"])

    header = (
        f"/**\n"
        f" * LTD2 Smart Overlay - Waves Database\n"
        f" * Auto-generated from Legion TD 2 API v{GAME_VERSION}\n"
        f" * {len(waves)} waves\n"
        f" */\n"
    )
    js = header + "window.SmartOverlayWaves = " + json.dumps(waves, indent=2) + ";\n"

    path = DATA_DIR / "waves-database.js"
    path.write_text(js)
    print(f"  Generated {path.name} ({len(waves)} waves, {len(js)} bytes)")


def main():
    api_key = load_api_key()
    units, waves, legions, abilities = fetch_all_data(api_key)

    print("\nSaving raw API responses...")
    save_raw(units, waves, legions, abilities)

    print("\nGenerating JavaScript database files...")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    generate_units_js(units)
    generate_waves_js(waves, units)

    print("\nDone!")


if __name__ == "__main__":
    main()
