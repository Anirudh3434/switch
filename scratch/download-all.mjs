import fs from "fs/promises";
import path from "path";

const API_KEY = "AQ.Ab8RN6IU-5HWod-HYXbwBt1srKLEHbKNF9iXdDcErdffcH9BNw";
const URL = "https://stitch.googleapis.com/mcp";

const PROJECT_ID = "9907340889054197745";
const SCREENS = [
  {
    title: "Swapped Session Toast",
    id: "3590177865a94071987485f8a2888879",
    slug: "swapped_session_toast"
  },
  {
    title: "Connected Devices",
    id: "079d6e6bd6354122b826aa83849864db",
    slug: "connected_devices"
  },
  {
    title: "Security & Account",
    id: "ed09e956649448a59f985a15dafdcbf4",
    slug: "security_and_account"
  },
  {
    title: "Vault Sessions",
    id: "5ade3b8a0a604f8d85fb62a363ecbcb2",
    slug: "vault_sessions"
  }
];

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
  const baseDir = path.resolve("stitch_designs");
  await fs.mkdir(baseDir, { recursive: true });

  const summary = [];

  for (const s of SCREENS) {
    console.log(`\n========================================`);
    console.log(`Processing: ${s.title} (${s.id})`);
    console.log(`========================================`);

    const screenDir = path.join(baseDir, s.slug);
    await fs.mkdir(screenDir, { recursive: true });

    // 1. Get screen metadata
    const screenMetaRes = await callTool("get_screen", {
      name: `projects/${PROJECT_ID}/screens/${s.id}`
    });

    let screenData = screenMetaRes.result?.structuredContent;
    if (!screenData && screenMetaRes.result?.content?.[0]?.text) {
      try {
        screenData = JSON.parse(screenMetaRes.result.content[0].text);
      } catch (e) {
        console.error("Failed to parse content text:", e);
      }
    }

    const htmlResourceName = screenData?.htmlCode?.name || `projects/${PROJECT_ID}/screens/${s.id}/fileEntries/html`;
    const screenshotResourceName = screenData?.screenshot?.name || `projects/${PROJECT_ID}/screens/${s.id}/fileEntries/screenshot`;

    console.log(`Downloading HTML: ${htmlResourceName}...`);
    const htmlRes = await callTool("download_file", { name: htmlResourceName });
    let htmlContent = htmlRes.result?.structuredContent?.html;
    if (!htmlContent && htmlRes.result?.content?.[0]?.text) {
      try {
        const parsed = JSON.parse(htmlRes.result.content[0].text);
        htmlContent = parsed.html || htmlRes.result.content[0].text;
      } catch {
        htmlContent = htmlRes.result.content[0].text;
      }
    }

    const htmlPath = path.join(screenDir, `${s.slug}.html`);
    if (htmlContent) {
      await fs.writeFile(htmlPath, htmlContent, "utf8");
      console.log(`Saved HTML (${htmlContent.length} bytes) to ${htmlPath}`);
    } else {
      console.warn(`Warning: No HTML content found for ${s.title}`);
    }

    console.log(`Downloading screenshot: ${screenshotResourceName}...`);
    const imgRes = await callTool("download_file", { name: screenshotResourceName });
    let base64Img = imgRes.result?.structuredContent?.image;
    let mimeType = imgRes.result?.structuredContent?.imageMetadata?.mimeType || "image/png";

    if (!base64Img && imgRes.result?.content?.[0]?.text) {
      try {
        const parsed = JSON.parse(imgRes.result.content[0].text);
        base64Img = parsed.image;
        if (parsed.imageMetadata?.mimeType) mimeType = parsed.imageMetadata.mimeType;
      } catch (e) {
        console.error("Failed to parse image JSON:", e);
      }
    }

    const ext = mimeType.includes("jpeg") || mimeType.includes("jpg") ? "jpg" : "png";
    const imgPath = path.join(screenDir, `${s.slug}.${ext}`);

    if (base64Img) {
      const buffer = Buffer.from(base64Img, "base64");
      await fs.writeFile(imgPath, buffer);
      console.log(`Saved screenshot image (${buffer.length} bytes) to ${imgPath}`);
    } else {
      // Fallback: try downloadUrl directly if available
      const downloadUrl = screenData?.screenshot?.downloadUrl;
      if (downloadUrl) {
        console.log(`Attempting downloadUrl fallback: ${downloadUrl.slice(0, 80)}...`);
        const imgFetch = await fetch(downloadUrl);
        if (imgFetch.ok) {
          const ab = await imgFetch.arrayBuffer();
          const buf = Buffer.from(ab);
          await fs.writeFile(imgPath, buf);
          console.log(`Saved screenshot from URL (${buf.length} bytes) to ${imgPath}`);
        }
      }
    }

    // Save metadata JSON
    const metaPath = path.join(screenDir, "metadata.json");
    await fs.writeFile(metaPath, JSON.stringify(screenData, null, 2), "utf8");

    summary.push({
      title: s.title,
      id: s.id,
      slug: s.slug,
      htmlPath: path.relative(baseDir, htmlPath).replace(/\\/g, "/"),
      imgPath: path.relative(baseDir, imgPath).replace(/\\/g, "/"),
      width: screenData?.width,
      height: screenData?.height,
      deviceType: screenData?.deviceType
    });
  }

  // Create summary README
  let readme = `# Modern Artisanal UI System (Stitch Project)\n\n`;
  readme += `**Project ID:** \`${PROJECT_ID}\`\n\n`;
  readme += `## Downloaded Screens\n\n`;

  for (const s of summary) {
    readme += `### ${s.title}\n`;
    readme += `- **Screen ID:** \`${s.id}\`\n`;
    readme += `- **Dimensions:** ${s.width} x ${s.height} (${s.deviceType || "MOBILE"})\n`;
    readme += `- **HTML Code:** [${s.htmlPath}](./${s.htmlPath})\n`;
    readme += `- **Screenshot:** [${s.imgPath}](./${s.imgPath})\n\n`;
    readme += `![${s.title}](./${s.imgPath})\n\n---\n\n`;
  }

  await fs.writeFile(path.join(baseDir, "README.md"), readme, "utf8");
  console.log(`\nSuccessfully downloaded all screens! Summary written to stitch_designs/README.md`);
}

main().catch(console.error);
