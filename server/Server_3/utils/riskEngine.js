function formatMoney(value) {
  if (Math.abs(value) >= 1) return Number(value.toFixed(2));
  if (Math.abs(value) >= 0.01) return Number(value.toFixed(4));
  return Number(value.toFixed(6));
}


function calculateDailyReturns(candles) {
  const returns = [];

  for (let i = 1; i < candles.length; i++) {
    const prevClose = candles[i - 1].close;
    const currClose = candles[i].close;

    if (!prevClose) continue;

    returns.push(
      (currClose - prevClose) / prevClose
    );
  }

  return returns;
}


function calculateVolatility(returns) {
  if (!returns || returns.length < 2) return 0;

  const mean =
    returns.reduce((sum, r) => sum + r, 0) /
    returns.length;

  const variance =
    returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) /
    (returns.length - 1);

  return Math.sqrt(variance);
}

function calculateConcentrationRisk(positions) {
  if (!positions || positions.length === 0) {
    return {
      max_weight: 0,
      dominant_asset: null,
      breakdown: {}
    };
  }

  const totalValue = positions.reduce(
    (sum, p) => sum + p.marketValue,
    0
  );

  if (totalValue === 0) {
    return {
      max_weight: 0,
      dominant_asset: null,
      breakdown: {}
    };
  }

  let maxWeight = 0;
  let dominantAsset = null;
  const breakdown = {};

  for (const pos of positions) {
    const weight = pos.marketValue / totalValue;
    breakdown[pos.symbol] = Number(weight.toFixed(4));

    if (weight > maxWeight) {
      maxWeight = weight;
      dominantAsset = pos.symbol;
    }
  }

  return {
    total_value: formatMoney(totalValue),
    max_weight: Number(maxWeight.toFixed(4)),
    dominant_asset: dominantAsset,
    breakdown
  };
}

function classifyPortfolioRisk(
  perAssetRisk,
  concentrationRisk,
  newsRisk
) {
  /* =========================
     1️⃣ VOLATILITY LEVEL
     ========================= */
  let volatilityLevel = "LOW";
  const vols = Object.values(perAssetRisk || {}).map(v => v.volatility);

  if (vols.length > 0) {
    const sorted = [...vols].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const avg = vols.reduce((s, v) => s + v, 0) / vols.length;
    const ratio = median > 0 ? avg / median : 0;

    if (ratio > 1.8) volatilityLevel = "HIGH";
    else if (ratio > 1.2) volatilityLevel = "MEDIUM";
  }

  /* =========================
     2️⃣ CONCENTRATION LEVEL
     ========================= */
  let concentrationLevel = "LOW";
  const weights = Object.values(concentrationRisk.breakdown || []);

  if (weights.length > 0) {
    const hhi = weights.reduce((s, w) => s + w * w, 0);
    const maxWeight = concentrationRisk.max_weight || 0;

    if (hhi > 0.4 || maxWeight > 0.6) {
      concentrationLevel = "HIGH";
    } else if (hhi > 0.25 || maxWeight > 0.4) {
      concentrationLevel = "MEDIUM";
    }
  }

  /* =========================
     3️⃣ NEWS LEVEL
     ========================= */
  const newsRiskLevel = newsRisk.level || "LOW";

  /* =========================
     4️⃣ OVERALL RISK (VOTING LOGIC)
     ========================= */
  const levels = [
    volatilityLevel,
    concentrationLevel,
    newsRiskLevel
  ];

  const highCount = levels.filter(l => l === "HIGH").length;
  const mediumCount = levels.filter(l => l === "MEDIUM").length;
  const lowCount = levels.filter(l => l === "LOW").length;

  let overallRisk = "LOW";

  if (highCount >= 2) {
    overallRisk = "HIGH";
  } else if (highCount === 1 && lowCount === 2) {
    overallRisk = "MEDIUM";
  } else if (mediumCount >= 2) {
    overallRisk = "MEDIUM";
  } else if (mediumCount === 1 && lowCount === 2) {
    overallRisk = "LOW";
  }

  /* =========================
     5️⃣ FINAL OUTPUT
     ========================= */
  return {
    overall_risk: overallRisk,
    volatility_level: volatilityLevel,
    concentration_level: concentrationLevel,
    news_risk_level: newsRiskLevel
  };
}




module.exports = {
  calculateDailyReturns,
  calculateVolatility,
  calculateConcentrationRisk,
  classifyPortfolioRisk
};