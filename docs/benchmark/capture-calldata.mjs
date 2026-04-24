/**
 * Captures the raw eth_call request/response for LensV2.getMarketsData
 * from the live testnet site by intercepting RPC traffic.
 */

import { chromium } from "playwright";
import fs from "fs";

const URL = process.argv[2] || "https://testnet.wildcat.finance/lender";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const captures = [];

  // Intercept all RPC calls
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("alchemy.com")) {
      try {
        const body = JSON.parse(req.postData());
        if (Array.isArray(body)) {
          for (const call of body) {
            if (call.method === "eth_call") captures.push({ request: call, url: req.url() });
          }
        } else if (body.method === "eth_call") {
          captures.push({ request: body, url: req.url() });
        }
      } catch {}
    }
  });

  page.on("response", async (res) => {
    if (res.request().method() === "POST" && res.url().includes("alchemy.com")) {
      try {
        const body = await res.json();
        if (Array.isArray(body)) {
          for (const resp of body) {
            const cap = captures.find((c) => c.request.id === resp.id && !c.response);
            if (cap) cap.response = resp;
          }
        } else if (body.id) {
          const cap = captures.find((c) => c.request.id === body.id && !c.response);
          if (cap) cap.response = body;
        }
      } catch {}
    }
  });

  console.log(`Navigating to ${URL}...`);
  await page.goto(URL, { waitUntil: "domcontentloaded" });

  console.log("Waiting for markets table to render...");
  await page.waitForFunction(
    () => document.querySelectorAll(".MuiDataGrid-row").length >= 3,
    null,
    { timeout: 60000 }
  );

  console.log(`Captured ${captures.length} eth_call requests`);

  // Find the largest response — that's the lens call
  const withResponses = captures.filter((c) => c.response?.result);
  withResponses.sort((a, b) => (b.response.result?.length || 0) - (a.response.result?.length || 0));

  for (const cap of withResponses.slice(0, 5)) {
    const sizeKB = ((cap.response.result.length - 2) / 2 / 1024).toFixed(1);
    const selector = cap.request.params?.[0]?.data?.slice(0, 10) || "?";
    console.log(`  ${selector} → ${sizeKB} KB response`);
  }

  // Save the top responses (lens calls)
  const lensCaptures = withResponses.filter(
    (c) => (c.response.result?.length || 0) > 10000
  );

  const output = lensCaptures.map((c) => ({
    to: c.request.params?.[0]?.to,
    data: c.request.params?.[0]?.data,
    result: c.response.result,
    sizeKB: ((c.response.result.length - 2) / 2 / 1024).toFixed(1),
  }));

  fs.writeFileSync("captured-calls.json", JSON.stringify(output, null, 2));
  console.log(`\nSaved ${output.length} large eth_call responses to captured-calls.json`);

  await browser.close();
}

main().catch(console.error);
