const { hasAnyAssetMention } =
  require("./assetDictionary.service");

async function classifyNewsCategory(title, content = "") {
  const text = `${title} ${content}`.toLowerCase();

  // 1️⃣ Regulatory
  if (
    text.includes("sec") ||
    text.includes("regulator") ||
    text.includes("government") ||
    text.includes("law") ||
    text.includes("ban") ||
    text.includes("compliance")
  ) {
    return "regulatory";
  }

  // 2️⃣ Exchange-level issues
  if (
    text.includes("exchange") ||
    text.includes("hack") ||
    text.includes("outage") ||
    text.includes("breach") ||
    text.includes("insolvency")
  ) {
    return "exchange";
  }

  // 3️⃣ Asset-specific (dynamic, alias-based)
  if (await hasAnyAssetMention(text)) {
    return "asset";
  }

  // 4️⃣ General market news
  return "general";
}

module.exports = { classifyNewsCategory };
