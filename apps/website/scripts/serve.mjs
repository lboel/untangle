import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceMode = process.argv.includes("--source");
const contentRoot = path.join(packageRoot, sourceMode ? "src" : "dist");
const portText = process.env.PORT ?? "4173";

if (!/^\d{1,5}$/u.test(portText)) {
  throw new Error(`website serve: invalid PORT ${portText}.`);
}

const port = Number(portText);
if (port < 1 || port > 65_535) {
  throw new Error(`website serve: PORT must be between 1 and 65535, received ${portText}.`);
}

if (!existsSync(path.join(contentRoot, "index.html"))) {
  throw new Error(
    sourceMode
      ? "website serve: src/index.html is missing."
      : "website serve: dist/ is missing. Run the website build first or pass --source.",
  );
}

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

const securityHeaders = {
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'none'; connect-src 'none'; font-src 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    const pathname = decodeURIComponent(requestUrl.pathname);
    const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = path.resolve(contentRoot, relativePath);
    const insideContentRoot =
      filePath === contentRoot || filePath.startsWith(`${contentRoot}${path.sep}`);

    if (!insideContentRoot) {
      response.writeHead(403, securityHeaders);
      response.end("Forbidden\n");
      return;
    }

    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) {
      response.writeHead(404, securityHeaders);
      response.end("Not found\n");
      return;
    }

    response.writeHead(200, {
      ...securityHeaders,
      "Content-Length": String(fileStats.size),
      "Content-Type": contentTypes.get(path.extname(filePath)) ?? "application/octet-stream",
    });
    createReadStream(filePath).pipe(response);
  } catch (error) {
    const status = error && typeof error === "object" && "code" in error ? 404 : 500;
    response.writeHead(status, securityHeaders);
    response.end(status === 404 ? "Not found\n" : "Internal server error\n");
  }
});

server.listen(port, "127.0.0.1", () => {
  const mode = sourceMode ? "src" : "dist";
  console.log(`website serve: ${mode}/ at http://127.0.0.1:${String(port)}`);
});
