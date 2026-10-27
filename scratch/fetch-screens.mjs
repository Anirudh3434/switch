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
  const data = await res.json();
  return data;
}

async function main() {
  const projectId = "9907340889054197745";
  console.log(`Calling list_screens for projectId: ${projectId}...`);
  const listRes = await callTool("list_screens", { projectId });
  console.log("list_screens result:", JSON.stringify(listRes, null, 2));
}

main().catch(console.error);
