const API_KEY = "AQ.Ab8RN6IU-5HWod-HYXbwBt1srKLEHbKNF9iXdDcErdffcH9BNw";
const URL = "https://stitch.googleapis.com/mcp";

async function postRpc(payload) {
  const headers = {
    "Content-Type": "application/json",
    "X-Goog-Api-Key": API_KEY,
  };
  const res = await fetch(URL, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  return await res.json();
}

async function main() {
  const res = await postRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {}
  });
  for (const tool of res.result.tools) {
    console.log(`Tool: ${tool.name}`);
    console.log(`  Description: ${tool.description}`);
    console.log(`  Parameters:`, Object.keys(tool.inputSchema.properties || {}));
  }
}

main().catch(console.error);
