const Trade = require("../models/trade");

const { getPrice } = require("../services/livePrice.service");
const {
  computePerAssetVolatility,
  computeConcentrationRisk,
  computeRiskClassification,
  computeScenarioShocks,
  computeShockPropagation,
  computeNewsRisk
} = require("../services/portfolioRisk.service");
const { computeCorrelationMatrix } =
  require("../services/correlation.service");
const News = require("../models/news");
const { generateScenarioFromNews } =
  require("../services/newsScenario.service");
const { applyScenarioImpact } =
  require("../services/scenarioImpact.service");

// Trade qty/price are stored as strings for precision. Always coerce explicitly
// before doing arithmetic to avoid string concatenation and NaN propagation.
function toNum(v, fallback = 0) {
  if (v == null) return fallback;
  if (v && typeof v === "object" && v._bsontype === "Decimal128" && typeof v.toString === "function") {
    v = v.toString();
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function tradeQty(t) {
  // Backward-compatible read: some older code used `quantity` while the schema uses `qty`
  return toNum(t?.qty ?? t?.quantity, 0);
}

 async function getUserPositions(userId) {
  const trades = await Trade.find({ userId });
  const map = {};

  for (const t of trades) {
    if (!map[t.symbol]) map[t.symbol] = 0;
    const q = tradeQty(t);
    t.side === "BUY" ? (map[t.symbol] += q) : (map[t.symbol] -= q);
  }

  return Object.entries(map)
    .filter(([_, q]) => q > 0)
    .map(([symbol, quantity]) => ({ symbol, quantity }));
}

exports.getNewsDrivenRisk = async (req, res) => {
  try {
    const userId = req.auth.userId;

    const negativeNews = await News.find({
      sentiment: "negative"
    }).sort({ published_at: -1 }).limit(3);

    if (!negativeNews.length) {
      return res.json({
        message: "No active news-driven risk scenarios",
        scenarios: []
      });
    }

    const results = [];
    let newsImpact = 0;
    for (const news of negativeNews) {
      const scenario = await generateScenarioFromNews(news);
      if (!scenario) continue;

      const trades = await Trade.find({ userId: req.auth.userId });

      const symbols = [
        ...new Set(trades.map(t => t.symbol))
      ];
      const impact =
        await applyScenarioImpact(userId, scenario, symbols);

      results.push({
        //news_id: news._id,
        headline: news.title,
        scenario_type: scenario.scenario_type,
        impact_summary:{
          total_loss: impact.totalImpact,
          breakdown: impact.breakdown
        }
      });
    }

    res.json({ news_risk_scenarios: results });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: "Failed to compute news-driven risk"
    });
  }
};

/* exports.getPortfolioRisk = async (req, res) => {
  try {
    const trades = await Trade.find({ userId: req.auth.userId });
    //console.log("Fetched trades for risk computation:", trades.length);
    // Build positions
    const positionsMap = {};

    for (const trade of trades) {
      if (!positionsMap[trade.symbol]) {
        positionsMap[trade.symbol] = {
          symbol: trade.symbol,
          quantity: 0
        };
      }

      if (trade.side === "BUY") {
        positionsMap[trade.symbol].quantity += tradeQty(trade);
      } else if (trade.side === "SELL") {
        positionsMap[trade.symbol].quantity -= tradeQty(trade);
      }
    }

    const positions = Object.values(positionsMap)
      .filter(p => p.quantity > 0);

    //console.log("Computed positions for risk:", positions);
    // Task 2.1
    const perAssetVolatility =
      await computePerAssetVolatility(positions);

    // Task 2.2
    const concentrationRisk =
      await computeConcentrationRisk(positions);

    const riskClassification =
        computeRiskClassification(
            perAssetVolatility,
            concentrationRisk
        );
    const scenarioShocks = await computeScenarioShocks(positions);
    
    const symbols = positions.map(p => p.symbol);

    const correlationMatrix = await computeCorrelationMatrix(symbols);


    res.json({
    per_asset_risk: perAssetVolatility,
    concentration_risk: concentrationRisk,
    risk_classification: riskClassification,
    scenario_shocks: scenarioShocks,
    correlation_Matrix: correlationMatrix,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: "Failed to compute portfolio risk"
    });
  }
}; */

exports.getRiskSummary = async (req, res) => {
  try {
    const positions = await getUserPositions(req.auth.userId);

    const perAssetRisk =
      await computePerAssetVolatility(positions);

    const concentrationRisk =
      await computeConcentrationRisk(positions);

    const portfolioValue = concentrationRisk.total_value;

      const symbols = positions.map(p => p.symbol);
    const newsRisk =
      await computeNewsRisk(req.auth.userId, portfolioValue, symbols);

    const riskClassification =
      computeRiskClassification(
        perAssetRisk,
        concentrationRisk,
        newsRisk
      );

    res.json({
      per_asset_risk: perAssetRisk,
      concentration_risk: concentrationRisk,
      risk_classification: riskClassification,
      news_risk: newsRisk
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Risk summary failed" });
  }
};

exports.getRiskScenarios = async (req, res) => {
  try {
    const shockParam = req.query.shock;

    // Default shocks
    let shocks = [-0.1, -0.2];

    if (shockParam) {
      shocks = shockParam
        .split(",")
        .map(Number)
        ;

      if (shocks.length === 0) {
        return res.status(400).json({
          message: "Invalid shock values"
        });
      }
    }
    for (const s of shocks) {
        if (s >= 0 || s < -1) {
          return res.status(400).json({
            message: "Shock values must be between -1 and 0"
          });
        }
      }
    const trades = await Trade.find({ userId: req.auth.userId });
    //const { shock } = req.query;
    const positionsMap = {};
    for (const t of trades) {
      if (!positionsMap[t.symbol]) {
        positionsMap[t.symbol] = { symbol: t.symbol, quantity: 0 };
      }
      t.side === "BUY"
        ? (positionsMap[t.symbol].quantity += tradeQty(t))
        : (positionsMap[t.symbol].quantity -= tradeQty(t));
    }

    const positions = Object.values(positionsMap)
      .filter(p => p.quantity > 0);

    const scenarioShocks =
      await computeScenarioShocks(positions, shocks);

    res.json({ scenario_shocks: scenarioShocks });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Scenario analysis failed" });
  }
};

exports.getCorrelationMatrix = async (req, res) => {
  try {
    const trades = await Trade.find({ userId: req.auth.userId });

    const symbols = [
      ...new Set(trades.map(t => t.symbol))
    ];

    if (symbols.length < 2) {
      return res.json({ correlation_matrix: {} });
    }

    const correlationMatrix =
      await computeCorrelationMatrix(symbols);

    res.json({ correlation_matrix: correlationMatrix });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Correlation failed" });
  }
};

exports.getShockPropagation = async (req, res) => {
  try {
    const { sourceAsset, shock } = req.query;

    if (!sourceAsset || !shock) {
      return res.status(400).json({
        message: "sourceAsset and shock are required"
      });
    }

    const shockPct = Number(shock);
    if (shockPct >= 0 || shockPct < -1) {
      return res.status(400).json({
        message: "shock must be between -1 and 0"
      });
    }

    const trades = await Trade.find({ userId: req.auth.userId });

    // Build positions
    const positionsMap = {};
    for (const t of trades) {
      if (!positionsMap[t.symbol]) {
        positionsMap[t.symbol] = { symbol: t.symbol, quantity: 0 };
      }
      t.side === "BUY"
        ? (positionsMap[t.symbol].quantity += tradeQty(t))
        : (positionsMap[t.symbol].quantity -= tradeQty(t));
    }

    const positions = Object.values(positionsMap)
      .filter(p => p.quantity > 0);

    // Enrich with prices
    const enrichedPositions = [];
    for (const p of positions) {
      const price = toNum(getPrice(p.symbol), 0);
      if (!price) continue;

      enrichedPositions.push({
        symbol: p.symbol,
        marketValue: toNum(p.quantity, 0) * price
      });
    }

    // Correlation matrix
    const symbols = enrichedPositions.map(p => p.symbol);
    const correlationMatrix =
      await computeCorrelationMatrix(symbols);

    // Shock propagation
    const propagation =
      await computeShockPropagation(
        enrichedPositions,
        correlationMatrix,
        sourceAsset,
        shockPct
      );

    res.json({
      source_asset: sourceAsset,
      base_shock_pct: shockPct * 100,
      portfolio_impact: {
        total_before: propagation.total_before,
        total_after: propagation.total_after,
        total_loss: propagation.total_loss,
        total_loss_pct:
          propagation.total_loss / propagation.total_before
      },
      asset_impacts: propagation.asset_impacts
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: "Shock propagation failed"
    });
  }
};

