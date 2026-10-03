const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../frontend/src");
const floatRe = /parseFloat|Math\.round|Math\.floor|Math\.ceil/;
const moneyRe = /deposit|payout|amount|refund|balance|wei|gen/i;
const windowSize = 5;

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) {
    console.error(`Missing frontend source directory: ${dir}`);
    process.exit(1);
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (/\.(js|jsx)$/.test(entry.name)) files.push(full);
  }
  return files;
}

const failures = [];
for (const file of walk(root)) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!floatRe.test(line)) return;
    const start = index - windowSize > 0 ? index - windowSize : 0;
    const end = Math.min(lines.length, index + windowSize + 1);
    const nearby = lines.slice(start, end).join("\n");
    if (moneyRe.test(nearby)) {
      failures.push(`${path.relative(process.cwd(), file)}:${index + 1}: ${line.trim()}`);
    }
  });
}

if (failures.length > 0) {
  console.error("Float money usage is not allowed:");
  failures.forEach((item) => console.error(`  ${item}`));
  process.exit(1);
}

console.log(`check-no-float-money: ok (${walk(root).length} files)`);
