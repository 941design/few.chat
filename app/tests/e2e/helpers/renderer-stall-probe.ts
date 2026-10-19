/**
 * Diagnostic for the composer stall (BACKLOG dm-composer-enter-press-hangs-30s):
 * under full-suite load a click or key press on the DM composer occasionally
 * waits 30 s in "performing click action", and even a DOM query fails after
 * it — the renderer's main thread is blocked.
 *
 * `armRendererStallProbe(page)` attaches a CDP session with the Debugger
 * enabled (that needs the main thread, so it is done early, well before the
 * action — enabling replays every loaded script and could itself perturb a
 * timing race). `withRendererStallProbe` runs the action; if it throws, it asks
 * V8 to pause the main thread and records the JavaScript stack and how long the
 * pause took. Under load these timings are only indications: a near-instant
 * pause most likely shows the script that was running, a late one may show the
 * next script instead, and no pause within the wait suggests (does not prove) a
 * block outside JavaScript. The report is printed and attached to the test, and
 * the original error is rethrown, so the test's outcome is unchanged.
 */
import { test, type CDPSession, type Page } from '@playwright/test';

type CallFrame = { functionName: string; url: string; location: { lineNumber: number; columnNumber: number } };

const ARM_WAIT_MS = 2_000;
const PAUSE_WAIT_MS = 5_000;

type Armed = CDPSession | { timedOutAt: number } | null;
const sessions = new WeakMap<Page, Promise<Armed>>();

function within<T>(ms: number, p: Promise<T>): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), ms); }),
  ]).finally(() => clearTimeout(timer));
}

async function attach(page: Page): Promise<Armed> {
  let expired = false;
  const init = (async () => {
    const cdp = await page.context().newCDPSession(page);
    if (expired) { void cdp.detach().catch(() => {}); return null; }
    // Not combined with Debugger.setSkipAllPauses: undoing it needs the main
    // thread, and while it is set V8 ignores Debugger.pause. App code has no
    // `debugger;` statements.
    await cdp.send('Debugger.enable');
    if (expired) { void cdp.detach().catch(() => {}); return null; }
    return cdp;
  })();
  try {
    const armed = await within(ARM_WAIT_MS, init);
    if (armed === 'timeout') {
      expired = true; // a session that arrives later detaches itself
      return { timedOutAt: Date.now() };
    }
    return armed;
  } catch {
    return null;
  }
}

function isSession(a: Armed): a is CDPSession {
  return !!a && !('timedOutAt' in a);
}

/** Attach the probe to a page; call it early, e.g. right after the page has loaded. */
export async function armRendererStallProbe(page: Page): Promise<void> {
  const prior = sessions.get(page);
  // An arm that timed out is retried (the thread may be free now).
  if (prior && !(await prior.then((a) => !!a && !isSession(a)))) return;
  const session = attach(page);
  sessions.set(page, session);
  if (!prior) {
    page.once('close', () => {
      void sessions.get(page)?.then((s) => (isSession(s) ? s.detach().catch(() => {}) : undefined));
    });
  }
  await session;
}

async function probeMainThread(page: Page, cdp: CDPSession): Promise<string> {
  if (page.isClosed()) return 'page closed';
  const sentAt = Date.now();
  const outcome = await within(PAUSE_WAIT_MS, new Promise<string>((resolve) => {
    cdp.once('Debugger.paused', (ev: { reason: string; callFrames: CallFrame[] }) => {
      const ms = Date.now() - sentAt;
      void cdp.send('Debugger.resume').catch(() => {});
      const stack = ev.callFrames
        .slice(0, 40)
        .map((f) => `  at ${f.functionName || '<anonymous>'} (${f.url}:${f.location.lineNumber + 1}:${f.location.columnNumber + 1})`)
        .join('\n');
      resolve(`paused ${ms} ms after the request (reason ${ev.reason}${ms > 200 ? '; late: possibly the next script rather than the one running at the stall' : ''}):\n${stack || '  (empty stack)'}`);
    });
    // Debugger.pause interrupts running JavaScript; it does not wait for the thread.
    cdp.send('Debugger.pause').catch((err: Error) => resolve(`pause request failed: ${err.message}`));
  }));
  if (outcome === 'timeout') {
    return page.isClosed()
      ? 'page closed'
      : `no JavaScript pause within ${PAUSE_WAIT_MS} ms (suggests a block outside JavaScript, or a delayed pause)`;
  }
  return outcome;
}

export async function withRendererStallProbe<T>(page: Page, label: string, action: () => Promise<T>): Promise<T> {
  await armRendererStallProbe(page);
  try {
    return await action();
  } catch (err) {
    let report: string;
    try {
      const armed = await sessions.get(page)!;
      report = isSession(armed)
        ? await probeMainThread(page, armed)
        : armed
          ? `probe not armed: arming timed out (${ARM_WAIT_MS} ms) ${Date.now() - armed.timedOutAt} ms before this report`
          : 'probe not armed (no CDP session)';
    } catch (probeErr) {
      report = `probe failed: ${(probeErr as Error).message}`;
    }
    const text = `[renderer-stall-probe] ${label} failed; main thread:\n${report}`;
    console.log(text);
    await test.info().attach(`renderer-stall-${label}`, { body: text, contentType: 'text/plain' }).catch(() => {});
    throw err;
  }
}
