function pearsonCorrelation(x, y) {
  if (x.length !== y.length || x.length < 2) return 0;

  const meanX = x.reduce((s, v) => s + v, 0) / x.length;
  const meanY = y.reduce((s, v) => s + v, 0) / y.length;

  let num = 0;
  let denomX = 0;
  let denomY = 0;

  for (let i = 0; i < x.length; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;

    num += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }

  const denom = Math.sqrt(denomX * denomY);
  return denom === 0 ? 0 : num / denom;
}

module.exports = { pearsonCorrelation };
