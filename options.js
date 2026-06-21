// Channel Age Watchdog — options page
// M4: store the user's YouTube Data API key in browser.storage.local. The key is
// never hardcoded and never transmitted anywhere except (later, in M5) Google's API.

const STORAGE_KEY = "apiKey";

const form = document.getElementById("form");
const input = document.getElementById("apiKey");
const reveal = document.getElementById("reveal");
const status = document.getElementById("status");

let statusTimer = null;

function showStatus(message, kind) {
  status.textContent = message;
  status.className = kind || "";
  if (statusTimer) clearTimeout(statusTimer);
  if (message) {
    statusTimer = setTimeout(() => {
      status.textContent = "";
      status.className = "";
    }, 4000);
  }
}

// Prefill the field with any previously saved key.
async function load() {
  try {
    const stored = await browser.storage.local.get(STORAGE_KEY);
    if (stored[STORAGE_KEY]) input.value = stored[STORAGE_KEY];
  } catch (err) {
    showStatus(`Could not read stored key: ${err.message}`, "err");
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
      showStatus("Saved.", "ok");
    } else {
      await browser.storage.local.remove(STORAGE_KEY);
      showStatus("Key cleared.", "ok");
    }
  } catch (err) {
    showStatus(`Could not save key: ${err.message}`, "err");
  }
}

reveal.addEventListener("change", () => {
  input.type = reveal.checked ? "text" : "password";
});

form.addEventListener("submit", save);
load();
