const cron = require("node-cron");
const {
  crawlCryptoNews
} = require("../services/newsCrawler.service");

async function runInitialNewsFetch() {
  console.log("Running initial news fetch...");

  try {
    await crawlCryptoNews();
  } catch (err) {
    console.error("Initial news fetch failed:", err.message);
  }
}


    //runInitialNewsFetch();
  // Every 1 hour
  cron.schedule("0 * * * *", async () => {
    console.log("Running scheduled news crawl...");

    try {
      await crawlCryptoNews();
      console.log("Hourly news crawl completed");
    } catch (err) {
      console.error("News crawl failed:", err.message);
    }
  });


//module.exports = { startNewsScheduler };
