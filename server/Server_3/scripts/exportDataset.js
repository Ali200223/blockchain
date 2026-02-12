require("../config/mongodb");

const { exportAllCoins } =
  require("../services/featureDataset.service");

(async () => {
  await exportAllCoins("1h");
  process.exit(0);
})();
