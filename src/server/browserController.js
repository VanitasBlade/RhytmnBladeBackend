import {ensureLoggedIn} from "../auth.js";
import {createBrowser} from "../browser.js";
import {BASE_URL} from "../config.js";

export function createBrowserController(state) {
  let queuedTaskCount = 0;

  function logQueue(message, payload = null) {
    if (payload) {
      console.log(`[browser-queue] ${message}`, payload);
      return;
    }
    console.log(`[browser-queue] ${message}`);
  }

  function runBrowserTask(task, label = "browser-task") {
    const waitingTasks = queuedTaskCount;
    queuedTaskCount += 1;
    if (waitingTasks > 0) {
      logQueue(`queued ${label}`, {waitingTasks});
    }

    const run = state.browserQueue.then(async () => {
      if (waitingTasks > 0) {
        logQueue(`starting ${label} after queue wait`, {waitingTasks});
      } else {
        logQueue(`starting ${label}`);
      }
      return task();
    });

    state.browserQueue = run.catch(() => {});
    return run.finally(() => {
      queuedTaskCount = Math.max(0, queuedTaskCount - 1);
      if (queuedTaskCount > 0) {
        logQueue(`completed ${label}`, {remainingTasks: queuedTaskCount});
      }
    });
  }

  async function initBrowser(authOverride = null) {
    if (!state.browserInstance) {
      state.browserInstance = await createBrowser();
    }

    const {page, context} = state.browserInstance;
    if (!state.browserInitialized || authOverride) {
      await ensureLoggedIn(page, context, authOverride || {});
      await page.goto(BASE_URL, {waitUntil: "domcontentloaded"});
      state.browserInitialized = true;
    }

    return state.browserInstance;
  }

  function getBrowserInstance() {
    return state.browserInstance;
  }

  return {
    runBrowserTask,
    initBrowser,
    getBrowserInstance,
  };
}
