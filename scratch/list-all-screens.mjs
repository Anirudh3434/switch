const API_KEY = "AQ.Ab8RN6IU-5HWod-HYXbwBt1srKLEHbKNF9iXdDcErdffcH9BNw";
const URL = "https://stitch.googleapis.com/mcp";

async function main() {
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "list_screens",
      arguments: { projectId: "9907340889054197745" }
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
  const list = data.result?.structuredContent?.screens || JSON.parse(data.result?.content?.[0]?.text || "[]");
  for (const s of list) {
    console.log(`Title: "${s.title}", ID: ${s.name?.split('/').pop()}, Width: ${s.width}, Height: ${s.height}`);
  }
}

main().catch(console.error);
