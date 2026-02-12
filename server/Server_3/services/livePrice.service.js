const prices = {}; 

function setPrice(symbol, price) {
  prices[symbol] = price;
}

function getPrice(symbol) {
  return prices[symbol];
}

function getAllPrices() {
  return prices;
}
module.exports = {
  setPrice,
  getPrice,
  getAllPrices
};
