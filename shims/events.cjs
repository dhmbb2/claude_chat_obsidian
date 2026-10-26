// Node's `events` for the Agent SDK inside Obsidian. In Electron's renderer the
// global AbortController is the browser one, and Node's setMaxListeners rejects
// its signals. The call only silences a listener-count warning, so skip it there.
const events = require("events");

module.exports = {
  ...events,
  setMaxListeners(n, ...targets) {
    try {
      return events.setMaxListeners(n, ...targets);
    } catch {
      // browser AbortSignal: nothing to configure
    }
  },
};
