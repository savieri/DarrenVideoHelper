const DEFAULT_SETTINGS = {
  outputDir: "~/Downloads/video_downloads",
  defaultQuality: "best",
  maxConcurrent: 2,
  autoCookies: true,
  skipDownloaded: true,
  onlyMp4: true,
  showAdvanced: false
};

const fields = {
  outputDir: document.getElementById("outputDir"),
  defaultQuality: document.getElementById("defaultQuality"),
  maxConcurrent: document.getElementById("maxConcurrent"),
  autoCookies: document.getElementById("autoCookies"),
  skipDownloaded: document.getElementById("skipDownloaded"),
  onlyMp4: document.getElementById("onlyMp4"),
  showAdvanced: document.getElementById("showAdvanced")
};
const statusEl = document.getElementById("status");
const saveButton = document.getElementById("saveButton");
const clearHistoryButton = document.getElementById("clearHistoryButton");

document.addEventListener("DOMContentLoaded", load);
saveButton.addEventListener("click", save);
clearHistoryButton.addEventListener("click", clearHistory);

async function load() {
  const response = await sendMessage({ type: "getSettings" });
  const settings = response.ok ? response.settings : DEFAULT_SETTINGS;
  fields.outputDir.value = settings.outputDir || DEFAULT_SETTINGS.outputDir;
  fields.defaultQuality.value = settings.defaultQuality || DEFAULT_SETTINGS.defaultQuality;
  fields.maxConcurrent.value = settings.maxConcurrent || DEFAULT_SETTINGS.maxConcurrent;
  fields.autoCookies.checked = settings.autoCookies !== false;
  fields.skipDownloaded.checked = settings.skipDownloaded !== false;
  fields.onlyMp4.checked = settings.onlyMp4 !== false;
  fields.showAdvanced.checked = settings.showAdvanced === true;
}

async function save() {
  const settings = {
    outputDir: fields.outputDir.value.trim() || DEFAULT_SETTINGS.outputDir,
    defaultQuality: fields.defaultQuality.value,
    maxConcurrent: Number(fields.maxConcurrent.value) || DEFAULT_SETTINGS.maxConcurrent,
    autoCookies: fields.autoCookies.checked,
    skipDownloaded: fields.skipDownloaded.checked,
    onlyMp4: fields.onlyMp4.checked,
    showAdvanced: fields.showAdvanced.checked
  };
  const response = await sendMessage({ type: "saveSettings", settings });
  if (!response.ok) throw new Error(response.error || "Save failed.");
  showStatus("Saved");
}

async function clearHistory() {
  const response = await sendMessage({ type: "clearHistory" });
  if (!response.ok) throw new Error(response.error || "Clear failed.");
  showStatus("History cleared");
}

function showStatus(text) {
  statusEl.textContent = text;
  window.setTimeout(() => { statusEl.textContent = "Options"; }, 1600);
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}
