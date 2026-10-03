const WEI_PER_GEN = 1000000000000000000n;

export const parseGenToWei = (genAmountStr) => {
  if (!genAmountStr) return 0n;
  const str = String(genAmountStr).trim();
  if (!/^\d+(\.\d+)?$/.test(str)) return 0n;
  const [intPart, fracPartRaw = ""] = str.split(".");
  const fracPart = (fracPartRaw + "0".repeat(18)).slice(0, 18);
  const wei = BigInt(intPart + fracPart);
  return wei > 0n ? wei : 0n;
};

export const formatWeiToGen = (val) => {
  if (val === null || val === undefined || val === "") return "0";
  let wei;
  try {
    wei = BigInt(val);
  } catch {
    return String(val);
  }
  if (wei === 0n) return "0";
  const intPart = wei / WEI_PER_GEN;
  const fracPart = wei % WEI_PER_GEN;
  if (fracPart === 0n) return intPart.toString();
  const fracStr = fracPart.toString().padStart(18, "0").replace(/0+$/, "");
  return fracStr.length > 0 ? `${intPart}.${fracStr}` : intPart.toString();
};

export const payoutWeiFromPercent = (depositWei, percent) => {
  const deposit = BigInt(depositWei);
  const pct = BigInt(percent);
  if (deposit <= 0n || pct <= 0n || pct >= 100n) return 0n;
  const raw = (deposit * pct) / 100n;
  if (raw <= 0n || raw >= deposit) return 0n;
  return raw;
};

export const subtractWei = (left, right) => {
  const a = BigInt(left);
  const b = BigInt(right);
  if (b >= a) return 0n;
  return a - b;
};

export const deadlineUnix = (days) => {
  const now = BigInt(Date.now()) / 1000n;
  return now + BigInt(days) * 86400n;
};

export const isValidPayout = (depositWei, payoutWei) => {
  const deposit = BigInt(depositWei);
  const payout = BigInt(payoutWei);
  return payout > 0n && payout < deposit;
};
