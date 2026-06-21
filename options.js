// Channel Age Watchdog — options page
// M4: store the user's YouTube Data API key in browser.storage.local. The key is
// never hardcoded and never transmitted anywhere except (later, in M5) Google's API.

const STORAGE_KEY = "apiKey";

const form = document.getElementById("form");
const input = document.getElementById("apiKey");
const reveal = document.getElementById("reveal");
const status = document.getElementById("status");

// Transient "Saved." / error feedback below a form. Each status element keeps its own
// auto-clear timer so the key form and the settings form don't clobber each other.
const statusTimers = new WeakMap();

function showStatus(el, message, kind) {
  el.textContent = message;
  el.className = kind || "";
  const prev = statusTimers.get(el);
  if (prev) clearTimeout(prev);
  if (message) {
    statusTimers.set(
      el,
      setTimeout(() => {
        el.textContent = "";
        el.className = "";
      }, 4000)
    );
  }
}

// Prefill the field with any previously saved key.
async function load() {
  try {
    const stored = await browser.storage.local.get(STORAGE_KEY);
    if (stored[STORAGE_KEY]) input.value = stored[STORAGE_KEY];
  } catch (err) {
    showStatus(status, `Could not read stored key: ${err.message}`, "err");
  }
}

// Save (or clear, if emptied) the key. Trimming guards against stray whitespace
// pasted alongside the key, which would otherwise produce 400s from the API.
async function save(event) {
  event.preventDefault();
  const key = input.value.trim();
  input.value = key;
  try {
    if (key) {
      await browser.storage.local.set({ [STORAGE_KEY]: key });
      showStatus(status, "Saved.", "ok");
    } else {
      await browser.storage.local.remove(STORAGE_KEY);
      showStatus(status, "Key cleared.", "ok");
    }
  } catch (err) {
    showStatus(status, `Could not save key: ${err.message}`, "err");
  }
}

reveal.addEventListener("change", () => {
  input.type = reveal.checked ? "text" : "password";
});

form.addEventListener("submit", save);
load();

// --- Detection settings (M7) ---------------------------------------------------

const settingsForm = document.getElementById("settingsForm");
const settingsStatus = document.getElementById("settingsStatus");
const fields = {
  ratioThreshold: document.getElementById("ratioThreshold"),
  scanFeed: document.getElementById("scanFeed"),
  showFlagged: document.getElementById("showFlagged"),
  showLegit: document.getElementById("showLegit"),
  showNeutral: document.getElementById("showNeutral"),
};
const daysPerVideoField = document.getElementById("daysPerVideo");
const BOOLEAN_FIELDS = ["scanFeed", "showFlagged", "showLegit", "showNeutral"];

// videos/day and days/video are reciprocals of the same rate. We only persist
// ratioThreshold (videos/day); the days/video field is a UI convenience. Round to
// drop floating-point noise (e.g. 1/3 -> 0.333333 rather than 0.33333333333) while
// keeping enough precision that the round-trip stays stable.
function formatRate(value) {
  if (!Number.isFinite(value) || value <= 0) return "";
  return String(parseFloat(value.toPrecision(6)));
}

// Mirror an edited rate field into its reciprocal. Setting .value programmatically
// does not fire an "input" event, so the two listeners never feed back into each
// other. A blank/invalid/non-positive entry just clears the counterpart.
function syncReciprocal(source, target) {
  const n = Number(source.value);
  target.value = source.value.trim() && Number.isFinite(n) && n > 0 ? formatRate(1 / n) : "";
}

// Populate the form from a settings object (defaults merged with stored values).
function fillSettingsForm(settings) {
  fields.ratioThreshold.value = formatRate(settings.ratioThreshold);
  daysPerVideoField.value = formatRate(1 / settings.ratioThreshold);
  for (const key of BOOLEAN_FIELDS) fields[key].checked = settings[key];
}

// getSettings() (settings.js) already sanitises numbers and merges defaults, so the
// form always loads with valid, complete values.
async function loadSettings() {
  fillSettingsForm(await getSettings());
}

// Save the form. Numeric inputs are validated here so a blank/zero/negative value is
// rejected with a clear message rather than silently disabling the heuristic.
async function saveSettings(event) {
  event.preventDefault();

  const ratioThreshold = Number(fields.ratioThreshold.value);
  if (!Number.isFinite(ratioThreshold) || ratioThreshold <= 0) {
    showStatus(settingsStatus, "Threshold must be a positive number.", "err");
    return;
  }

  const settings = { ratioThreshold };
  for (const key of BOOLEAN_FIELDS) settings[key] = fields[key].checked;

  try {
    await browser.storage.local.set({ [SETTINGS_KEY]: settings });
    showStatus(settingsStatus, "Settings saved.", "ok");
  } catch (err) {
    showStatus(settingsStatus, `Could not save settings: ${err.message}`, "err");
  }
}

// Reset the form to defaults and persist them in one step.
async function resetSettings() {
  fillSettingsForm(DEFAULT_SETTINGS);
  try {
    await browser.storage.local.set({ [SETTINGS_KEY]: { ...DEFAULT_SETTINGS } });
    showStatus(settingsStatus, "Reset to defaults.", "ok");
  } catch (err) {
    showStatus(settingsStatus, `Could not reset: ${err.message}`, "err");
  }
}

fields.ratioThreshold.addEventListener("input", () =>
  syncReciprocal(fields.ratioThreshold, daysPerVideoField)
);
daysPerVideoField.addEventListener("input", () =>
  syncReciprocal(daysPerVideoField, fields.ratioThreshold)
);

settingsForm.addEventListener("submit", saveSettings);
document.getElementById("reset").addEventListener("click", resetSettings);
loadSettings();

// --- Trusted channels (M8.5) ---------------------------------------------------
// List the user's trust allowlist with a per-row "Remove" button. Entries are added
// from the in-page badge popup; this page is where they're reviewed and removed.

const trustedList = document.getElementById("trustedList");

// Build one row for a trusted channel: its title, a link to the channel, and Remove.
function trustedRow(channelId, entry) {
  const row = document.createElement("div");
  row.className = "trusted-row";

  const meta = document.createElement("div");
  meta.className = "meta";
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = entry.title || channelId;
  const sub = document.createElement("div");
  sub.className = "sub";
  const link = document.createElement("a");
  link.href = `https://www.youtube.com/channel/${channelId}`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = channelId;
  sub.append("Channel: ", link);
  meta.append(title, sub);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "Remove";
  remove.addEventListener("click", async () => {
    await untrustChannel(channelId);
    renderTrusted();
  });

  row.append(meta, remove);
  return row;
}

// Render (or re-render) the trusted-channel list, sorted by title, with an empty state.
async function renderTrusted() {
  const map = await getTrustedChannels();
  const ids = Object.keys(map);
  trustedList.textContent = "";

  if (ids.length === 0) {
    const empty = document.createElement("p");
    empty.className = "trusted-empty";
    empty.textContent =
      "No trusted channels yet. Use “trust this channel” on a channel badge to add one.";
    trustedList.appendChild(empty);
    return;
  }

  ids.sort((a, b) => (map[a].title || a).localeCompare(map[b].title || b));
  for (const id of ids) trustedList.appendChild(trustedRow(id, map[id]));
}

renderTrusted();
