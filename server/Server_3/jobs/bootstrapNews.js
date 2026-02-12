const {
  crawlCryptoNews
} = require("../services/newsCrawler.service");

module.exports =async function runInitialNewsFetch() {
  console.log("Running initial news fetch...");

  try {
    await crawlCryptoNews();
  } catch (err) {
    console.error("Initial news fetch failed:", err.message);
  }
}