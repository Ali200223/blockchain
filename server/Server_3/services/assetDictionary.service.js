const MarketSymbol = require("../models/marketSymbol");

const ASSET_ALIASES = {
  btc: ["btc", "bitcoin"],
  eth: ["eth", "ethereum"],
  sol: ["sol", "solana"],
  bnb: ["bnb", "binance coin"],
  xrp: ["xrp", "ripple"],
  ada: ["ada", "cardano"],
  doge: ["doge", "dogecoin"]
};

let assetMap = null;

async function loadAssetMap() {
  if (assetMap) return assetMap;

  const symbols = await MarketSymbol.find(
    {},
    { symbol: 1, _id: 0 }
  );

  assetMap = {};

  for (const s of symbols) {
    const base = s.symbol.replace("USDT", "").toLowerCase();

    const rawAliases = ASSET_ALIASES[base] || [base.toUpperCase()];

    // Filter unsafe aliases
    const aliases = rawAliases.filter(
      a =>
        typeof a === "string" &&
        a.length >= 3 &&
        /^[a-zA-Z ]+$/.test(a)
    );

    const patterns = aliases.map(alias => {
      // Uppercase ticker → case-sensitive
      if (alias === alias.toUpperCase() && alias.length <= 5) {
        return new RegExp(`\\b${alias}\\b`);
      }

      // Full name → case-insensitive
      return new RegExp(`\\b${alias}\\b`, "i");
    });

    assetMap[base] = {
      pair: s.symbol,
      aliases,
      patterns
    };
  }

  return assetMap;
}

async function extractAffectedAssets(text) {
  const map = await loadAssetMap();
  const lowerText = text.toLowerCase();

  const affected = [];

  for (const base in map) {
    for (const pattern of map[base].patterns) {
      if (pattern.test(lowerText)) {
        affected.push(map[base].pair);
        break;
      }
    }
  }

  return affected.length ? affected : null;
}

async function hasAnyAssetMention(text) {
  const map = await loadAssetMap();
  const lowerText = text.toLowerCase();

  for (const base in map) {
    for (const pattern of map[base].patterns) {
      if (pattern.test(lowerText)) {
        return true;
      }
    }
  }
  return false;
}

async function getAssetAliases() {
  const map = await loadAssetMap();
  const aliasMap = {};

  for (const base in map) {
    aliasMap[map[base].pair] =
      map[base].patterns.map(p =>
        p.source.replace(/\\b/g, "")
      );
  }

  return aliasMap;
}

module.exports = {
  loadAssetMap,
  extractAffectedAssets,
  hasAnyAssetMention,
  getAssetAliases
};
