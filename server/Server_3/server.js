require("dotenv").config();

const app = require("./app");
const connectDB = require("./config/mongodb");

connectDB('mongodb://127.0.0.1:27017/Crypto_data');

app.listen(4000, () => {
  console.log("Server running on port 4000");
});
