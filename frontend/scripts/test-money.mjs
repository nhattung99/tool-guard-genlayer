import {
  formatWeiToGen,
  isValidPayout,
  parseGenToWei,
  payoutWeiFromPercent,
  subtractWei,
} from "../src/money.js";

const wei = 1000000000000000000n;

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

assertEqual(parseGenToWei("1"), wei, "1 GEN");
assertEqual(parseGenToWei("1.5"), 15n * 10n ** 17n, "1.5 GEN");
assertEqual(parseGenToWei("0.000000000000000001"), 1n, "1 wei");
assertEqual(parseGenToWei("0"), 0n, "zero");
assertEqual(parseGenToWei("abc"), 0n, "invalid");
assertEqual(formatWeiToGen(wei), "1", "format 1");
assertEqual(formatWeiToGen(15n * 10n ** 17n), "1.5", "format 1.5");
assertEqual(formatWeiToGen(1n), "0.000000000000000001", "format 1 wei");
assertEqual(payoutWeiFromPercent(10n * wei, 10), wei, "10 percent");
assertEqual(payoutWeiFromPercent(10n * wei, 50), 5n * wei, "50 percent");
assertEqual(payoutWeiFromPercent(10n * wei, 100), 0n, "100 percent rejected");
assertEqual(subtractWei(10n * wei, 4n * wei), 6n * wei, "refund");
assertEqual(isValidPayout(10n * wei, 4n * wei), true, "valid payout");
assertEqual(isValidPayout(10n * wei, 10n * wei), false, "payout not below deposit");

console.log("test-money: ok");
