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
  const projectId = "9907340889054197745";
  const screens = [
    { title: "Swapped Session Toast", id: "3590177865a94071987485f8a2888879" },
    { title: "Connected Devices", id: "079d6e6bd6354122b826aa83849864db" },
    { title: "Security & Account", id: "ed09e956649448a59f985a15dafdcbf4" },
    { title: "Vault Sessions", id: "5ade3b8a0a604f8d85fb62a363ecbcb2" }
  ];

  for (const s of screens) {
    console.log(`\n--- Fetching screen details: ${s.title} (${s.id}) ---`);
    const screenRes = await callTool("get_screen", {
      name: `projects/${projectId}/screens/${s.id}`
    });
    console.log("Screen metadata:", JSON.stringify(screenRes, null, 2));
  }
}

main().catch(console.error);
