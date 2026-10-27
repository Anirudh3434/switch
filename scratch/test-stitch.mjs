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
  const json = await res.json();
  return json;
}

async function main() {
  console.log("Listing tools...");
  const listToolsPayload = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {}
  };
  const res = await postRpc(listToolsPayload);
  console.log("Tools response:", JSON.stringify(res, null, 2));
}

main().catch(console.error);
