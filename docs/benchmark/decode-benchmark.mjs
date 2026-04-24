/**
 * Isolated benchmark: ethers.js v5 vs viem ABI decoding
 * of Wildcat LensV2.getMarketsData() responses.
 *
 * Captures the actual RPC response from the live site, then
 * decodes it offline with both libraries and compares.
 *
 * Usage: node decode-benchmark.mjs [testnet|mainnet]
 */

import { ethers } from "ethers";
import { decodeFunctionResult } from "viem";
import { chromium } from "playwright";
import fs from "fs";

const lensV2Abi = JSON.parse(fs.readFileSync(new URL("./lensV2-full-abi.json", import.meta.url), "utf8"));
const lensV1Abi = JSON.parse(fs.readFileSync(new URL("./lensV1-full-abi.json", import.meta.url), "utf8"));

const ITERATIONS = 30;

const KNOWN_LENS = {
  // Sepolia
  "0x5d8ceacee19c06c3b4108b8ae5b881eb0240b9c7": { version: "V2", abi: lensV2Abi },
  // Mainnet V2
  "0xfda5c5b96bb198d2fca1a01d759620b64ae5afe7": { version: "V2", abi: lensV2Abi },
  // Mainnet V1
  "0xf1d516954f96c1363f8b0ae48d79c8dde6237847": { version: "V1", abi: lensV1Abi },
};

// ── Capture from live site ──────────────────────────────────────────

async function captureFromSite(url) {
  console.log(`Capturing lens responses from ${url}...`);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const rpcBodies = [];

  page.on("request", (req) => {
    if (req.method() !== "POST") return;
    try {
      const body = JSON.parse(req.postData());
      const calls = Array.isArray(body) ? body : [body];
      for (const call of calls) {
        if (call.method === "eth_call") {
          rpcBodies.push({ id: call.id, params: call.params, url: req.url() });
        }
      }
    } catch {}
  });

  page.on("response", async (res) => {
    if (res.request().method() !== "POST") return;
    try {
      const body = await res.json();
      const resps = Array.isArray(body) ? body : [body];
      for (const resp of resps) {
        const cap = rpcBodies.find((c) => c.id === resp.id && !c.result);
        if (cap && resp.result) {
          cap.result = resp.result;
          cap.to = cap.params?.[0]?.to?.toLowerCase();
          cap.calldata = cap.params?.[0]?.data;
        }
      }
    } catch {}
  });

  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.querySelectorAll(".MuiDataGrid-row").length >= 3,
    null,
    { timeout: 60000 }
  );

  // Wait a bit more for all responses
  await new Promise((r) => setTimeout(r, 3000));
  await browser.close();

  // Filter to known lens contracts with results
  const lensResponses = rpcBodies.filter(
    (c) => c.result && c.to && KNOWN_LENS[c.to]
  );
  console.log(`Captured ${lensResponses.length} lens call responses`);
  return lensResponses;
}

// ── Benchmarking ────────────────────────────────────────────────────

function benchEthers(hex, lensAbi, n) {
  const iface = new ethers.utils.Interface(lensAbi);
  // Determine which function was called based on the ABI
  // Both getMarketsData and getMarketsDataWithLenderStatus have selector 0xe85dfdf0 / similar
  // Try to decode with getMarketsData first, fall back to getMarketsDataWithLenderStatus
  let fragment;
  for (const name of ["getMarketsData", "getMarketsDataWithLenderStatus"]) {
    try {
      fragment = iface.getFunction(name);
      iface.decodeFunctionResult(fragment, hex);
      break;
    } catch { fragment = null; }
  }
  if (!fragment) throw new Error("Could not decode with any known function");

  // Warmup
  iface.decodeFunctionResult(fragment, hex);
  iface.decodeFunctionResult(fragment, hex);

  const times = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    iface.decodeFunctionResult(fragment, hex);
    times.push(performance.now() - t0);
  }
  return { times, functionName: fragment.name };
}

function benchViem(hex, lensAbi, functionName, n) {
  const fnAbi = lensAbi.filter((f) => f.name === functionName);

  // Warmup
  decodeFunctionResult({ abi: fnAbi, functionName, data: hex });
  decodeFunctionResult({ abi: fnAbi, functionName, data: hex });

  const times = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    decodeFunctionResult({ abi: fnAbi, functionName, data: hex });
    times.push(performance.now() - t0);
  }
  return times;
}

function calcStats(times) {
  const s = [...times].sort((a, b) => a - b);
  return {
    min: s[0],
    median: s[Math.floor(s.length / 2)],
    mean: times.reduce((a, b) => a + b, 0) / times.length,
    p95: s[Math.floor(s.length * 0.95)],
    max: s[s.length - 1],
  };
}

function fmt(ms) { return ms.toFixed(1) + " ms"; }
function pad(s, w) { return String(s).padStart(w); }

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const arg = process.argv[2] || "testnet";
  const url = arg === "mainnet"
    ? "https://app.wildcat.finance/lender"
    : "https://testnet.wildcat.finance/lender";

  const captures = await captureFromSite(url);
  if (captures.length === 0) {
    console.error("No lens responses captured!");
    process.exit(1);
  }

  // Combine all lens responses for a complete picture
  // But benchmark the LARGEST one (main lens call) individually
  captures.sort((a, b) => (b.result.length || 0) - (a.result.length || 0));
  const main = captures[0];
  const lensInfo = KNOWN_LENS[main.to];

  const sizeKB = ((main.result.length - 2) / 2 / 1024).toFixed(1);
  console.log(`\nLargest response: ${sizeKB} KB from ${lensInfo.version} lens`);

  // Ethers decode
  console.log("\nRunning ethers.js v5.7.2 decode...");
  const ethersResult = benchEthers(main.result, lensInfo.abi, ITERATIONS);
  const e = calcStats(ethersResult.times);
  const fnName = ethersResult.functionName;

  // Get market count
  const iface = new ethers.utils.Interface(lensInfo.abi);
  const decoded = iface.decodeFunctionResult(iface.getFunction(fnName), main.result);
  const marketCount = decoded[0].length;

  // Viem decode
  console.log("Running viem v2 decode...");
  const viemTimes = benchViem(main.result, lensInfo.abi, fnName, ITERATIONS);
  const v = calcStats(viemTimes);

  const speedup = e.median / v.median;

  console.log("\n" + "═".repeat(72));
  console.log(`  ${arg} — ${marketCount} markets — ${sizeKB} KB — ${fnName}`);
  console.log("═".repeat(72));
  console.log("");
  console.log("              │   min     │  median   │   mean    │   p95     │   max");
  console.log("  ────────────┼───────────┼───────────┼───────────┼───────────┼──────────");
  console.log(
    `  ethers v5   │ ${pad(fmt(e.min), 8)} │ ${pad(fmt(e.median), 8)} │ ${pad(fmt(e.mean), 8)} │ ${pad(fmt(e.p95), 8)} │ ${pad(fmt(e.max), 8)}`
  );
  console.log(
    `  viem v2     │ ${pad(fmt(v.min), 8)} │ ${pad(fmt(v.median), 8)} │ ${pad(fmt(v.mean), 8)} │ ${pad(fmt(v.p95), 8)} │ ${pad(fmt(v.max), 8)}`
  );
  console.log("  ────────────┼───────────┼───────────┼───────────┼───────────┼──────────");
  console.log(`  speedup     │           │ ${pad(speedup.toFixed(1) + "x", 8)} │`);
  console.log("");

  // If there are multiple lens responses, show combined totals
  if (captures.length > 1) {
    console.log(`  (${captures.length} total lens calls captured — benchmarked largest only)`);
    const totalKB = captures.reduce((s, c) => s + (c.result.length - 2) / 2 / 1024, 0);
    console.log(`  Total response data: ${totalKB.toFixed(1)} KB across all calls\n`);

    // Also benchmark ALL responses combined
    console.log("  Benchmarking ALL lens responses combined...");
    let ethersTotal = 0, viemTotal = 0;
    for (const cap of captures) {
      const info = KNOWN_LENS[cap.to];
      if (!info) continue;
      const eResult = benchEthers(cap.result, info.abi, 5);
      const eStat = calcStats(eResult.times);
      const vTimes = benchViem(cap.result, info.abi, eResult.functionName, 5);
      const vStat = calcStats(vTimes);
      ethersTotal += eStat.median;
      viemTotal += vStat.median;
    }
    console.log(`  Combined ethers median: ${fmt(ethersTotal)}`);
    console.log(`  Combined viem median:   ${fmt(viemTotal)}`);
    console.log(`  Combined speedup:       ${(ethersTotal / viemTotal).toFixed(1)}x\n`);
  }

  // Save results
  const results = {
    network: arg,
    markets: marketCount,
    responseSizeKB: parseFloat(sizeKB),
    functionName: fnName,
    iterations: ITERATIONS,
    ethers: { ...e, raw: ethersResult.times },
    viem: { ...v, raw: viemTimes },
    speedup,
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(`results-${arg}.json`, JSON.stringify(results, null, 2));
  console.log(`Results saved to results-${arg}.json`);
}

main().catch(console.error);
