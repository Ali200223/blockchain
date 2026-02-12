
async function generateScenarioFromNews(news) {

  if (!news || news.sentiment !== "negative") {
    return null;
  }

  if (news.category === "regulatory") {
    return {
      news_id: news._id,
      scenario_type: "regulatory_stress",
      scope: "market",
      shock: -0.1,
      affected_assets: "ALL",
      reason: "Negative regulatory news detected"
    };
  }

  if (news.category === "exchange") {
    return {
      news_id: news._id,
      scenario_type: "exchange_stress",
      scope: "market",
      shock: -0.1,
      affected_assets: "ALL",
      reason: "Negative exchange-related news detected"
    };
  }

  if (news.category === "asset") {
    if (!Array.isArray(news.asset_sentiments)) {
      return null;
    }

    const negativelyAffected = news.asset_sentiments
      .filter(a => a.sentiment === "negative")
      .map(a => a.pair);

    
    if (!negativelyAffected.length) {
      return null;
    }

    return {
      news_id: news._id,
      scenario_type: "asset_stress",
      scope: "asset",
      shock: -0.1,
      affected_assets: negativelyAffected,
      reason: "Negative asset-specific news detected"
    };
  }

  return null;
}

module.exports = { generateScenarioFromNews };
