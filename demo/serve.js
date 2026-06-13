// Zero-dep static server for the demo. Serves the project root so the
// importmap can reach ../Charts.js plus jsdelivr-hosted peers.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT) || 8080;
const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE, "..");

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js":   "text/javascript; charset=utf-8",
    ".mjs":  "text/javascript; charset=utf-8",
    ".css":  "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg":  "image/svg+xml",
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".ico":  "image/x-icon"
};

createServer(async (req, res) => {
    const url = decodeURIComponent((req.url || "/").split("?")[0]);
    const safe = normalize(url).replace(/^(\.\.[/\\])+/, "");
    let path = safe === "/" || safe === "" ? "/demo/index.html" : safe;
    if (path.endsWith("/")) path += "index.html";
    const full = join(ROOT, path);
    if (!full.startsWith(ROOT)) { res.writeHead(403); res.end("Forbidden"); return; }
    try {
        const s = await stat(full);
        if (s.isDirectory()) { res.writeHead(301, { Location: path + "/" }); res.end(); return; }
        const body = await readFile(full);
        res.writeHead(200, {
            "Content-Type": MIME[extname(full).toLowerCase()] || "application/octet-stream",
            "Cache-Control": "no-store"
        });
        res.end(body);
    } catch (e) {
        if (e.code === "ENOENT") { res.writeHead(404); res.end("Not found: " + path); }
        else { res.writeHead(500); res.end(String(e)); }
    }
}).listen(PORT, () => {
    console.log("lite-charts demo: http://localhost:" + PORT + "/demo/");
});
