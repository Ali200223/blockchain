const Candle = require("../models/candle");
const { getPrice } = require("../services/livePrice.service");
const News = require("../models/news");
const { generateScenarioFromNews } =
  require("./newsScenario.service");
const { applyScenarioImpact } =
  require("./scenarioImpact.service");
//const { calculateConcentrationRisk } = require("../utils/riskEngine");

const {
  calculateDailyReturns,
  calculateVolatility,
  calculateConcentrationRisk,
  classifyPortfolioRisk
} = require("../utils/riskEngine");

// services/portfolioRisk.service.js
function formatMoney(value) {
  if (value?._bsontype === 'Decimal128') {
    value = value.toString();
  }

  const num = Number(value);
  if (!Number.isFinite(num)) return 0;

  if (Math.abs(num) >= 1) return Number(num.toFixed(2));
  if (Math.abs(num) >= 0.01) return Number(num.toFixed(4));
  return Number(num.toFixed(6));
}


async function computeNewsRisk(userId, portfolioValue, symbols) {
  const negativeNews = await News.find({
    sentiment: "negative"
  })
    .sort({ published_at: -1 })
    .limit(2);

  let totalImpactValue = 0;
  let totalShock = 0;
  const drivers = [];

  for (const news of negativeNews) {
    const scenario = await generateScenarioFromNews(news);
    if (!scenario) continue;

    // Asset relevance check
    if (
      scenario.scope === "asset" &&
      Array.isArray(scenario.affected_assets)
    ) {
      const intersects = scenario.affected_assets.some(
        a => symbols.includes(a)
      );
      if (!intersects) continue;
    }

    const impact =
      await applyScenarioImpact(userId, scenario, symbols);

    const impactValue = Math.abs(impact.totalImpact);

    totalImpactValue += impactValue;
    totalShock += Math.abs(scenario.shock);

    drivers.push({
      headline: news.title,
      category: news.category,
      scenario_type: scenario.scenario_type,
      affected_assets: scenario.affected_assets,
      shock_pct: scenario.shock * 100
    });
  }

  const impactRatio =
    portfolioValue > 0
      ? totalImpactValue / portfolioValue
      : 0;

  let level = "LOW";

  if (drivers.length > 0) {
    level = "MEDIUM";
  }

  if (
    impactRatio >= 0.05 ||
    totalShock >= 0.3
  ) {
    level = "HIGH";
  }

  return {
    level,
    estimated_impact: Number(totalImpactValue.toFixed(2)),
    impact_ratio: Number((impactRatio * 100).toFixed(2)),
    active_events: drivers.length,
    drivers
  };
}




async function computePerAssetVolatility(positions) {
  const result = {};

  for (const pos of positions) {
    let candles = await Candle.find({
      symbol: pos.symbol,
      interval: "1d"
    }).sort({ timestamp: 1 });

    if (!candles || candles.length < 2){
      candles = await fetchKlines(pos.symbol, "1d", 30);

    };

    const returns = calculateDailyReturns(candles);
    const volatility = calculateVolatility(returns);

    result[pos.symbol] = {
      volatility: volatility.toFixed(4)
    };
  }

  return result;
}

async function computeConcentrationRisk(positions) {
  const enrichedPositions = [];

  for (const pos of positions) {
    const price = getPrice(pos.symbol);
    if (!price) continue;

    enrichedPositions.push({
      symbol: pos.symbol,
      quantity: pos.quantity,
      marketValue:Number(pos.quantity) * Number(price)
    });
  }

  return calculateConcentrationRisk(enrichedPositions);
}

function computeRiskClassification(perAssetRisk, concentrationRisk, newsRisk) {
  return classifyPortfolioRisk(
    perAssetRisk,
    concentrationRisk,
    newsRisk
  );
}

function applyScenarioShocks(positions, shocks = [-0.1, -0.2]) {
  const totalValue = positions.reduce(
    (sum, p) => sum + p.marketValue,
    0
  );

  const scenarios = {};

  for (const shock of shocks) {
    let shockedValue = 0;
    const perAssetImpact = {};

    for (const pos of positions) {
      const newValue = pos.marketValue * (1 + shock);
      shockedValue += newValue;

      perAssetImpact[pos.symbol] = {
        before: formatMoney(pos.marketValue),
        after: formatMoney(newValue),
        loss: formatMoney(pos.marketValue - newValue)
      };
    }

    scenarios[`${shock * 100}%`] = {
      portfolio_value_before: formatMoney(totalValue),
      portfolio_value_after: formatMoney(shockedValue),
      portfolio_loss: formatMoney(totalValue - shockedValue),
      portfolio_loss_pct: formatMoney(
        ((totalValue - shockedValue) / totalValue).toFixed(4)
      ),
      per_asset_impact: perAssetImpact
    };
  }

  return scenarios;
}

async function computeScenarioShocks(positions, shocks) {
  const enrichedPositions = [];

  for (const pos of positions) {
    const price = getPrice(pos.symbol);
    if (!price) continue;

    enrichedPositions.push({
      symbol: pos.symbol,
      quantity: pos.quantity,
      marketValue: pos.quantity * price
    });
  }

  return applyScenarioShocks(enrichedPositions, shocks);
}

const { propagateShock } =
  require("../utils/shockPropagation");

async function computeShockPropagation(
  positions,
  correlationMatrix,
  sourceAsset,
  shockPct
) {
  return propagateShock(
    positions,
    correlationMatrix,
    sourceAsset,
    shockPct
  );
}


module.exports = {
  computePerAssetVolatility,
  computeConcentrationRisk,
  computeRiskClassification,
  applyScenarioShocks,
  computeScenarioShocks,
  computeShockPropagation,
  computeNewsRisk
};
