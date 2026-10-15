// Detects `next dev` output lines proving the dev server hot-reloaded or errored
// mid-run (e.g. someone editing app/ while e2e runs). Initial compiles
// ("Compiling", "Compiled") and 4xx responses (e.g. /version.json 404) are fine.
const ANSI = /\u001b\[[0-9;]*m/g;
const FULL_RELOAD = /Fast Refresh had to perform a full reload/i;
const HTTP_5XX = /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \S+ 5\d\d in\b/;

export function isReloadOrErrorLine(line) {
  const text = String(line).replace(ANSI, "");
  return FULL_RELOAD.test(text) || HTTP_5XX.test(text);
}

// Line-buffered scanner: feed raw chunks, collect offending lines.
export function createReloadDetector() {
  const offending = [];
  let pending = "";
  const scan = (line) => { if (isReloadOrErrorLine(line)) offending.push(line.replace(ANSI, "").trim()); };
  return {
    offending,
    feed(chunk) {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      lines.forEach(scan);
    },
    flush() { if (pending) { scan(pending); pending = ""; } },
  };
}
