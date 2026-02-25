import cors from "cors";
import express from "express";

import {createBrowserController} from "./src/server/browserController.js";
import {createDownloadEngine} from "./src/server/downloadEngine.js";
import {registerRoutes} from "./src/server/routes.js";
import {createSearchEngine} from "./src/server/searchEngine.js";
import {createServerState} from "./src/server/state.js";

const app = express();
app.use(cors());
app.use(express.json());

const LOG_HTTP_REQUESTS = process.env.LOG_HTTP_REQUESTS !== "false";
let requestCounter = 0;

if (LOG_HTTP_REQUESTS) {
  app.use((req, res, next) => {
    requestCounter += 1;
    const requestId = `${Date.now().toString(36)}_${requestCounter.toString(36)}`;
    const startedAt = Date.now();
    console.log(`[http ${requestId}] -> ${req.method} ${req.originalUrl}`);

    res.on("finish", () => {
      console.log(
        `[http ${requestId}] <- ${req.method} ${req.originalUrl} status=${res.statusCode} durationMs=${Date.now() - startedAt}`
      );
    });

    res.on("close", () => {
      if (!res.writableEnded) {
        console.log(
          `[http ${requestId}] !! ${req.method} ${req.originalUrl} closed-before-finish durationMs=${Date.now() - startedAt}`
        );
      }
    });

    next();
  });
}

const state = createServerState();
const browserController = createBrowserController(state);
const searchEngine = createSearchEngine(state, browserController);
const downloadEngine = createDownloadEngine({
  state,
  browserController,
  searchEngine,
});

registerRoutes({
  app,
  searchEngine,
  downloadEngine,
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
