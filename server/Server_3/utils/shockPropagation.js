function propagateShock(
  positions,
  correlationMatrix,
  sourceAsset,
  shockPct
) {
  const result = {};
  let totalBefore = 0;
  let totalAfter = 0;

  for (const pos of positions) {
    totalBefore += pos.marketValue;

    let appliedShock = 0;

    if (pos.symbol === sourceAsset) {
      appliedShock = shockPct;
    } else {
      const corr =
        correlationMatrix[sourceAsset]?.[pos.symbol] || 0;
      appliedShock = shockPct * corr;
    }

    const afterValue =
      pos.marketValue * (1 + appliedShock);

    totalAfter += afterValue;

    result[pos.symbol] = {
      shock_applied_pct: Number((appliedShock * 100).toFixed(2)),
      before: Number(pos.marketValue.toFixed(2)),
      after: Number(afterValue.toFixed(2))
    };
  }

  return {
    total_before: Number(totalBefore.toFixed(2)),
    total_after: Number(totalAfter.toFixed(2)),
    total_loss: Number((totalBefore - totalAfter).toFixed(2)),
    asset_impacts: result
  };
}

module.exports = { propagateShock };
