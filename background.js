// Channel Age Watchdog — background (event page)
// M4: minimal seam so the content-script notice can open the Options page. Content
// scripts cannot call browser.runtime.openOptionsPage() themselves, and Firefox
// blocks navigating to moz-extension:// links from web content. M5 will extend this
// page with the actual YouTube Data API calls.

browser.runtime.onMessage.addListener((message) => {
  if (message && message.type === "openOptions") {
    return browser.runtime.openOptionsPage();
  }
});
