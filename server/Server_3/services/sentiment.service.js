const positiveKeywords = {
  "approval": 2,
  "approved": 2,
  "adoption": 2,
  "partnership": 2,

  "growth": 1,
  "bullish": 2,
  "rally": 2,
  "record high": 3,
  "adds": 2,
  "rise": 1,
  "surge": 2,
  "breakout": 2,
  "upgrade": 1,
  "expansion": 1,
  "institutional": 2,

  "etf": 3,
  "inflow": 2,
  "support": 1,
  "accumulate": 1,
  "rebound": 1,

  "needed": 0.5,
  "safe haven": 2,
  "hedge": 1,
  "store of value": 2,

  "alternative": 0.5,
  "solution": 1,
  "protection": 1,
  "benefit": 1
};


const negativeKeywords = {
  "hack": -4,
  "hacked": -4,
  "exploit": -4,
  "breach": -4,

  "lawsuit": -2,
  "fraud": -4,

  "ban": -4,
  "crackdown": -4,
  "investigation": -2,
  "penalty": -2,
  "fine": -1,
  "collapse": -5,
  "insolvency": -5,
  "scam": -5,

  "volatility": -1,
  "risk": -1,
  "decline": -2,
  "drop": -2,
  "loss": -2,
  "sell-off": -2,
  "bearish": -2,

  "outage": -3,
  "fall": -2
};


const negations = ["not", "no", "avoid", "avoids", "prevent", "prevents", "denies"];

function splitClauses(text) {
  return text
    .toLowerCase()
    .split(/,|;| but | while | as | and /);
}

function isNegated(clause, word) {
  const index = clause.indexOf(word);
  if (index === -1) return false;

  const window = clause.slice(Math.max(0, index - 20), index);
  return negations.some(n => window.includes(n));
}
function hasWord(text, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`\\b${escaped}\\b`, "i");
  return regex.test(text);
}
/**
 * Analyze sentiment for ONE asset using its aliases
 */
function analyzeAssetSentiment(aliases, title) {
  if (!Array.isArray(aliases)) {
    throw new Error("aliases must be an array");
  }

  const clauses = splitClauses(title);
  let score = 0;
  let mentions = 0;

  for (const clause of clauses) {
    if (!aliases.some(a => hasWord(clause, a.toLowerCase()))) continue;
    mentions++;

    for (const [word, weight] of Object.entries(negativeKeywords)) {
      if (hasWord(clause, word) && !isNegated(clause, word)) {
        score += weight;
      }
    }

    for (const [word, weight] of Object.entries(positiveKeywords)) {
      if (hasWord(clause, word) && !isNegated(clause, word)) {
        score += weight;
      }
    }
  }

  if (mentions === 0) return { sentiment: "neutral", score: 0 };

  if (score <= -2) return { sentiment: "negative", score };
  if (score >= 2) return { sentiment: "positive", score };
  return { sentiment: "neutral", score };
}

function analyzeHeadlineSentiment(title) {
  const text = title.toLowerCase();
  let score = 0;
  
  for (const [word, weight] of Object.entries(negativeKeywords)) {
    if (hasWord(text, word)) {
      score += weight;
    }
  }

  for (const [word, weight] of Object.entries(positiveKeywords)) {
    if (hasWord(text, word)) {
      score += weight;
    }
  }

  if (score <= -2) return { sentiment: "negative", score };
  if (score >= 2) return { sentiment: "positive", score };
  return { sentiment: "neutral", score };
}


module.exports = { analyzeAssetSentiment, analyzeHeadlineSentiment};