import fs from "fs/promises";
import path from "path";

const API_KEY = "AQ.Ab8RN6IU-5HWod-HYXbwBt1srKLEHbKNF9iXdDcErdffcH9BNw";
const URL = "https://stitch.googleapis.com/mcp";

async function callTool(name, args) {
  const payload = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: {
      name,
      arguments: args
    }
  };
  const res = await fetch(URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": API_KEY,
    },
    body: JSON.stringify(payload)
  });
  return await res.json();
}

async function main() {
  const htmlFile = "projects/9907340889054197745/screens/3590177865a94071987485f8a2888879/fileEntries/html";
  console.log("Calling download_file for HTML...");
  const resHtml = await callTool("download_file", { name: htmlFile });
  console.log("HTML response keys:", Object.keys(resHtml));
  if (resHtml.result) {
    console.log("result keys:", Object.keys(resHtml.result));
    console.log("structuredContent keys:", Object.keys(resHtml.result.structuredContent || {}));
    if (resHtml.result.structuredContent?.html) {
      console.log("HTML preview (first 200 chars):", resHtml.result.structuredContent.html.slice(0, 200));
    }
  }

  const screenshotFile = "projects/9907340889054197745/screens/3590177865a94071987485f8a2888879/fileEntries/screenshot";
  console.log("Calling download_file for Screenshot...");
  const resImg = await callTool("download_file", { name: screenshotFile });
  if (resImg.result) {
    console.log("structuredContent keys for img:", Object.keys(resImg.result.structuredContent || {}));
  }
}

main().catch(console.error);
