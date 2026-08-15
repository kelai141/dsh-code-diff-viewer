// dsh-code-diff-viewer — host half.
// Serves POST /cdv-locate: given { path, needle }, reads the file (current on-disk
// state) and returns the 1-based line where the needle's first unambiguous
// occurrence starts. The client uses this to render absolute line numbers for
// edit/write diff hunks (the wire hunks carry 3 context lines, so hunk-relative
// numbering would be off by that offset).
import { readFileSync } from "node:fs";

const name = "code-diff-viewer-host";
const inject = ["webServer"];

/** Progressively shorter needle candidates: full hunk, minus trailing context, leading context. */
function needleCandidates(needle) {
  const lines = needle.split("\n");
  const out = [needle];
  if (lines.length > 3) out.push(lines.slice(0, -3).join("\n"));
  if (lines.length > 6) out.push(lines.slice(0, -6).join("\n"));
  if (lines.length > 3) out.push(lines.slice(0, 3).join("\n"));
  out.push(needle.slice(0, 60));
  return out;
}

function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/cdv-locate",
    handler: (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json" });
        res.end(JSON.stringify({ start: null }));
        return;
      }
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 2_000_000) req.destroy();
      });
      req.on("end", () => {
        let path = "";
        let needle = "";
        try {
          const parsed = JSON.parse(body);
          if (parsed && typeof parsed === "object") {
            if (typeof parsed.path === "string") path = parsed.path;
            if (typeof parsed.needle === "string") needle = parsed.needle;
          }
        } catch {
          /* malformed body → { start: null } */
        }
        let start = null;
        if (path !== "" && needle !== "") {
          try {
            const norm = readFileSync(path, "utf8").replace(/\r\n?/g, "\n");
            for (const cand of needleCandidates(needle)) {
              const idx = norm.indexOf(cand);
              if (idx >= 0) {
                start = norm.slice(0, idx).split("\n").length;
                break;
              }
            }
          } catch {
            /* unreadable file → { start: null } */
          }
        }
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ start }));
      });
    }
  }));
}

export { apply, inject, name };
