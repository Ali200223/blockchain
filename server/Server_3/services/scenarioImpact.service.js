const Trade = require("../models/trade");
const { getPrice } = require("../services/livePrice.service");
const { computeCorrelationMatrix } =
  require("../services/correlation.service");

// Trade qty/price are stored as strings for precision. Coerce explicitly for arithmetic.
function toNum(v, fallback = 0) {
  if (v == null) return fallback;
  if (v && typeof v === "object" && v._bsontype === "Decimal128" && typeof v.toString === "function") {
    v = v.toString();
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Compute portfolio positions
 */
async function getPortfolioPositions(userId) {
  const trades = await Trade.find({ userId });
  const positions = {};

  for (const t of trades) {
    if (!positions[t.symbol]) {
      positions[t.symbol] = 0;
    }

    const q = toNum(t.qty ?? t.quantity, 0);

    t.side === "BUY" ? (positions[t.symbol] += q) : (positions[t.symbol] -= q);
  }

  return Object.entries(positions)
    .filter(([_, qty]) => qty > 0)
    .map(([symbol, quantity]) => ({ symbol, quantity }));
}

/**
 * Apply scenario shock to portfolio
 */
async function applyScenarioImpact(userId, scenario, symbols) {
  const positions = await getPortfolioPositions(userId);
  const correlationMatrix = await computeCorrelationMatrix(symbols);

  let totalImpact = 0;
  const breakdown = [];

  for (const pos of positions) {
    const price = toNum(getPrice(pos.symbol), 0);
    if (!price) continue;

    let shock = 0;

    if (scenario.scope === "market") {
      shock = scenario.shock;
    }

    if (
      scenario.scope === "asset" &&
      scenario.affected_assets.includes(pos.symbol)
    ) {
      shock = scenario.shock;
    }

    if (
      scenario.scope === "asset" &&
      !scenario.affected_assets.includes(pos.symbol)
    ) {
      const corr =
        correlationMatrix?.[scenario.affected_assets[0]]?.[pos.symbol] || 0;
      shock = scenario.shock * corr;
    }

    const positionValue = toNum(pos.quantity, 0) * price;
    const impact = positionValue * shock;

    totalImpact += impact;

    breakdown.push({
      symbol: pos.symbol,
      shock: Number(shock.toFixed(3)),
      impact: Number(impact.toFixed(2))
    });
  }

  return {
    scenario_type: scenario.scenario_type,
    totalImpact: Number(totalImpact.toFixed(2)),
    breakdown
  };
}

module.exports = { applyScenarioImpact };
