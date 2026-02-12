const News = require("../models/news");
const Parser = require("rss-parser");
const {
  classifyNewsCategory
} = require("../services/newsCategory.service");
const {
  extractAffectedAssets,
  getAssetAliases
} = require("../services/assetDictionary.service");

const {
  analyzeAssetSentiment, analyzeHeadlineSentiment
} = require("../services/sentiment.service");

const parser = new Parser({
  requestOptions: {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/rss+xml, application/xml;q=0.9, */*;q=0.8"
    }
  }
});

async function crawlCryptoNews() {
  const feed = await parser.parseURL("https://cointelegraph.com/rss");
  const aliasMap = await getAssetAliases();

  let count = 0;

  for (const item of feed.items) {
    try {
      const title = item.title;
      const content = item.contentSnippet || "";
      const category = await classifyNewsCategory(title, content);
      const affectedPairs = await extractAffectedAssets(title);

      let sentiment = "neutral";
      let asset_sentiments = [];

      if (category === "asset" && affectedPairs) {
        for (const pair of affectedPairs) {
          const aliases = aliasMap[pair];

          if (!aliases) continue;

          const result = analyzeAssetSentiment(
            aliases,
            title
          );

          asset_sentiments.push({
            pair,
            sentiment: result.sentiment,
            score: result.score
          });
        }

        if (asset_sentiments.some(a => a.sentiment === "negative")) {
          sentiment = "negative";
        } else if (asset_sentiments.some(a => a.sentiment === "positive")) {
          sentiment = "positive";
        }
      }else if (category === "regulatory" || category === "exchange") {
        const headlineSentiment = analyzeHeadlineSentiment(title);
        sentiment = headlineSentiment.sentiment;
      }
/*       console.log({
        title,
        category,
        computedSentiment: sentiment,
        headlineAnalysis:
          category === "regulatory"
            ? analyzeHeadlineSentiment(title)
            : null
      }); */
      await News.create({
        title,
        url: item.link,
        source: "Cointelegraph",
        published_at: item.pubDate ? new Date(item.pubDate) : new Date(),
        content,
        category,
        sentiment,
        asset_sentiments
      });

      count++;
    } catch (err) {
      if (err.code !== 11000) {
        console.error("News insert error:", err.message);
      }
    }
  }

  console.log(`Crypto news saved: ${count}`);
}

module.exports = { crawlCryptoNews };
