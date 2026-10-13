// Browser flasher for the rosin press board (docs/update_strategy.md).
//
// Update: writes only the app at 0x10000, so NVS (presets, IP, tuning) is
// kept. Full install: bootloader, partition table, blank NVS and app. A full
// install is forced when the board is blank, runs other firmware, or has a
// partition table that differs from the release's.

import { ESPLoader, Transport } from "./vendor/esptool-js-0.7.0/bundle.js";

const PROJECT = "rosin_press_firmware";
const CHIP = "ESP32-S3";
const FLASH_SIZE = "16MB";
const APP_DESC_ADDR = 0x10020;      // after the app's image and segment headers
const APP_DESC_MAGIC = 0xabcd5432;
const PARTITION_TABLE_ADDR = 0x8000;
const PARTITION_TABLE_SIZE = 0xc00;
const NVS = { offset: 0x9000, size: 0x6000 };
const ROM_BAUD = 115200;
const BAUD = 460800;
// CP2102N on the board (J8); CH343 on the DevKitC-1 bench rig.
const PORT_FILTERS = [{ usbVendorId: 0x10c4 }, { usbVendorId: 0x1a86 }];
const TRACE = new URLSearchParams(location.search).has("trace");

const $ = (id) => document.getElementById(id);
const ui = {
  connect: $("connect"), disconnect: $("disconnect"), connectStatus: $("connect-status"),
  board: $("board"), installed: $("installed"), available: $("available"),
  release: $("release"), notes: $("notes"), plan: $("plan"),
  confirmRow: $("confirm-row"), confirm: $("confirm"), confirmText: $("confirm-text"),
  advanced: $("advanced"), full: $("full"), install: $("install"),
  progress: $("progress"), barFill: $("bar-fill"), progressText: $("progress-text"),
  done: $("done"), doneVersion: $("done-version"), log: $("log"),
};

const state = {
  releases: [],
  transport: null,
  loader: null,
  board: null,        // { app: {version, project} | null, partitionMd5: string }
  busy: false,
  binCache: new Map(),
};

const terminal = {
  clean() { ui.log.textContent = ""; },
  writeLine(line) { log(line); },
  write(text) { ui.log.textContent += text; },
};

function log(line) {
  ui.log.textContent += line + "\n";
  ui.log.scrollTop = ui.log.scrollHeight;
}

function setStatus(el, text, kind = "") {
  el.textContent = text;
  el.className = el.className.replace(/\b(good|bad|warn)\b/g, "").trim();
  if (kind) el.classList.add(kind);
}

function cString(bytes) {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end));
}

// esp_app_desc_t: magic, secure_version, 2 reserved words, version[32], project_name[32].
function parseAppDesc(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== APP_DESC_MAGIC) return null;
  return { version: cString(bytes.subarray(16, 48)), project: cString(bytes.subarray(48, 80)) };
}

async function fetchBin(file) {
  if (!state.binCache.has(file.path)) {
    const res = await fetch(file.path, { cache: "no-cache" });
    if (!res.ok) throw new Error(`Download failed: ${file.path} (${res.status})`);
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.length !== file.size) throw new Error(`Download incomplete: ${file.path}`);
    state.binCache.set(file.path, data);
  }
  return state.binCache.get(file.path);
}

function selectedRelease() {
  return state.releases[ui.release.selectedIndex] ?? null;
}

// ---- Releases ------------------------------------------------------------

async function loadReleases() {
  try {
    const res = await fetch("releases.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(res.status);
    const index = await res.json();
    state.releases = index.releases ?? [];
  } catch (e) {
    log(`releases.json: ${e}`);
    setStatus(ui.plan, "Couldn't load the list of firmware versions. Check the internet connection and reload the page.", "bad");
    return;
  }
  ui.release.replaceChildren(...state.releases.map((r, i) => {
    const opt = document.createElement("option");
    opt.textContent = `${r.version}  (${r.date})${i === 0 ? "  latest" : ""}`;
    return opt;
  }));
  ui.release.disabled = state.releases.length === 0;
  if (state.releases.length === 0) setStatus(ui.plan, "No firmware has been published yet.", "bad");
  showNotes();
}

function showNotes() {
  const r = selectedRelease();
  ui.notes.textContent = r?.notes ?? "";
}

// ---- Connect -------------------------------------------------------------

async function connect() {
  let port;
  try {
    port = await navigator.serial.requestPort({ filters: PORT_FILTERS });
  } catch {
    return;   // chooser closed without picking a port
  }
  setBusy(true);
  ui.done.hidden = true;
  setStatus(ui.connectStatus, "Connecting…");
  try {
    // One silent retry covers a glitch on the USB link, so a technician
    // doesn't have to click Connect twice.
    for (let attempt = 1; ; attempt++) {
      try {
        await openBoard(port);
        break;
      } catch (e) {
        log(`Connect attempt ${attempt} failed: ${e?.message ?? e}`);
        dumpTrace();
        await closePort();
        if (attempt >= 2 || e instanceof WrongBoard || isPortBusy(e)) throw e;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    setStatus(ui.connectStatus, "Board connected.", "good");
    ui.connect.hidden = true;
    ui.disconnect.hidden = false;
    showBoard();
  } catch (e) {
    resetBoardUi("");
    setStatus(ui.connectStatus, connectHint(e), "bad");
  } finally {
    setBusy(false);
  }
}

class WrongBoard extends Error {}

async function openBoard(port) {
  state.transport = new Transport(port, TRACE);
  state.loader = new ESPLoader({
    transport: state.transport, baudrate: BAUD, romBaudrate: ROM_BAUD, terminal,
  });
  await state.loader.main();

  const chip = state.loader.chip.CHIP_NAME;
  if (chip !== CHIP) throw new WrongBoard(`This is an ${chip}, not the press controller board.`);
  const flashSize = await state.loader.detectFlashSize();
  if (flashSize !== FLASH_SIZE) throw new WrongBoard(`Flash size ${flashSize}, expected ${FLASH_SIZE}. This isn't the press controller board.`);

  const app = parseAppDesc(await readFlashWhole(APP_DESC_ADDR, 256));
  // An MD5 instead of a read: one short reply, compared with the release's.
  const partitionMd5 = await state.loader.flashMd5sum(PARTITION_TABLE_ADDR, PARTITION_TABLE_SIZE);
  state.board = { app, partitionMd5 };
  log(`Installed app: ${app ? `${app.project} ${app.version}` : "none"}, partition table md5 ${partitionMd5}`);
}

// After the data, the stub sends a 16-byte MD5 of it and only then takes the
// next command. esptool-js 0.7.0's readFlash returns without waiting for that
// packet, so a command sent straight after can be lost (traced on the bench
// rig, 2026-10-09). Python esptool reads it; so do we.
async function readFlashWhole(addr, size) {
  const data = await state.loader.readFlash(addr, size);
  try {
    const digest = await state.transport.read(1000);
    if (digest.length !== 16) log(`Unexpected ${digest.length}-byte packet after reading flash`);
  } catch {
    log("No MD5 packet after reading flash");
  }
  return data;
}

// With ?trace=1 in the address, every serial byte goes into the log on failure.
function dumpTrace() {
  if (TRACE && state.transport?.traceLog) log(state.transport.traceLog);
}

function isPortBusy(e) {
  return /open|access|busy/i.test(String(e?.message ?? e));
}

function connectHint(e) {
  if (isPortBusy(e)) {
    return "The port is in use. Close any other program using it (serial monitor, another browser tab) and try again.";
  }
  if (e instanceof WrongBoard) return e.message;
  return "Couldn't talk to the board. Check the USB cable is in J8, unplug and replug it, then try again.";
}

function showBoard() {
  const app = state.board.app;
  let installed = "No firmware";
  if (app && app.project === PROJECT) installed = app.version;
  else if (app) installed = `Other firmware (${app.project})`;
  ui.installed.textContent = installed;
  ui.available.textContent = state.releases[0]?.version ?? "none";
  ui.board.hidden = false;
  updatePlan();
}

// Restarts the board into its firmware before letting go of the port, so it
// is never left waiting in download mode.
async function closePort({ reset = true } = {}) {
  if (reset && state.loader) {
    try { await state.loader.after("hard_reset"); } catch { /* cable already gone */ }
  }
  try { await state.transport?.disconnect(); } catch { /* already gone */ }
  state.transport = null;
  state.loader = null;
  state.board = null;
}

async function disconnect() {
  await closePort();
  resetBoardUi("Disconnected.");
}

function resetBoardUi(message) {
  ui.connect.hidden = false;
  ui.disconnect.hidden = true;
  ui.board.hidden = true;
  setStatus(ui.connectStatus, message);
  updatePlan();
}

// ---- Plan ----------------------------------------------------------------

// Decides between update and full install for the selected release.
async function planFor(release) {
  const app = state.board.app;
  if (!app) return { full: true, text: "No firmware on the board yet: this will be a first install." };
  if (app.project !== PROJECT) {
    return {
      full: true, confirm: true, kind: "warn",
      text: `This board runs other firmware (${app.project}).`,
      confirmText: "Replace it with the rosin press firmware. Everything on the board will be erased.",
    };
  }
  const table = release.files.partition_table;
  if (table.size !== PARTITION_TABLE_SIZE || table.md5 !== state.board.partitionMd5) {
    return {
      full: true, confirm: true, kind: "warn",
      text: `${release.version} changes the board's memory layout, so it needs a full install.`,
      confirmText: "Install anyway. All settings (presets, IP address, power limits, tuning) reset to factory defaults.",
    };
  }
  if (ui.full.checked) {
    return {
      full: true, confirm: true, kind: "warn",
      text: "Full install selected.",
      confirmText: "Reset all settings (presets, IP address, power limits, tuning) to factory defaults.",
    };
  }
  const same = app.version === release.version;
  return {
    full: false,
    text: same ? `${release.version} is already installed. Installing it again keeps all settings.`
               : `Update from ${app.version} to ${release.version}. All settings are kept.`,
  };
}

let planToken = 0;
async function updatePlan() {
  const token = ++planToken;
  const release = selectedRelease();
  ui.confirmRow.hidden = true;
  ui.confirm.checked = false;
  if (!state.board || !release) {
    state.plan = null;
    if (state.releases.length) setStatus(ui.plan, state.board ? "" : "Connect to the board first.");
    refreshInstallButton();
    return;
  }
  try {
    const plan = await planFor(release);
    if (token !== planToken) return;
    state.plan = plan;
    setStatus(ui.plan, plan.text, plan.kind ?? "");
    ui.confirmRow.hidden = !plan.confirm;
    ui.confirmText.textContent = plan.confirmText ?? "";
    ui.install.textContent = plan.full ? "Install firmware" : "Install update";
  } catch (e) {
    log(String(e?.message ?? e));
    state.plan = null;
    setStatus(ui.plan, "Couldn't download the firmware files. Check the internet connection.", "bad");
  }
  refreshInstallButton();
}

function refreshInstallButton() {
  const p = state.plan;
  ui.install.disabled = state.busy || !state.board || !p || (p.confirm && !ui.confirm.checked);
}

function setBusy(busy) {
  state.busy = busy;
  ui.connect.disabled = busy;
  ui.disconnect.disabled = busy;
  ui.release.disabled = busy || state.releases.length === 0;
  ui.full.disabled = busy;
  ui.confirm.disabled = busy;
  refreshInstallButton();
}

// ---- Install -------------------------------------------------------------

async function install() {
  const release = selectedRelease();
  const plan = state.plan;
  if (!release || !plan) return;
  setBusy(true);
  ui.done.hidden = true;
  ui.progress.hidden = false;
  setProgress(0, "Downloading firmware…");

  try {
    const f = release.files;
    const writes = [];
    if (plan.full) {
      writes.push({ file: f.bootloader, data: await fetchBin(f.bootloader) });
      writes.push({ file: f.partition_table, data: await fetchBin(f.partition_table) });
      writes.push({ file: { offset: NVS.offset, size: NVS.size }, data: new Uint8Array(NVS.size).fill(0xff) });
    }
    writes.push({ file: f.app, data: await fetchBin(f.app) });

    const total = writes.reduce((n, w) => n + w.data.length, 0);
    const before = writes.map((_, i) => writes.slice(0, i).reduce((n, w) => n + w.data.length, 0));
    setProgress(0, "Writing firmware… don't unplug the cable.");
    await state.loader.writeFlash({
      fileArray: writes.map((w) => ({ data: w.data, address: w.file.offset })),
      flashMode: "keep", flashFreq: "keep", flashSize: "keep",
      eraseAll: false,
      compress: true,
      reportProgress: (i, written, size) => {
        const done = before[i] + writes[i].data.length * (written / size);
        setProgress(0.9 * done / total, "Writing firmware… don't unplug the cable.");
      },
    });

    setProgress(0.92, "Checking what was written…");
    for (const w of writes) {
      if (!w.file.md5) continue;   // the blank NVS area has no release MD5
      const md5 = await state.loader.flashMd5sum(w.file.offset, w.file.size);
      log(`0x${w.file.offset.toString(16)}: flash md5 ${md5}, expected ${w.file.md5}`);
      if (md5.toLowerCase() !== w.file.md5.toLowerCase()) {
        throw new Error(`Check failed at 0x${w.file.offset.toString(16)}`);
      }
    }

    setProgress(0.97, "Restarting the board…");
    await state.loader.after("hard_reset");
    await closePort({ reset: false });

    setProgress(1, "Done.");
    ui.doneVersion.textContent = release.version;
    ui.done.hidden = false;
    resetBoardUi("Board restarted and disconnected.");
  } catch (e) {
    log(`Install failed: ${e?.message ?? e}`);
    dumpTrace();
    setProgress(null, "The install didn't finish. The board is safe to retry: reconnect and install again.", "bad");
    await closePort();
    resetBoardUi("Disconnected after the failed install.");
  } finally {
    setBusy(false);
  }
}

function setProgress(fraction, text, kind = "") {
  if (fraction !== null) ui.barFill.style.width = `${Math.round(fraction * 100)}%`;
  setStatus(ui.progressText, text, kind);
}

// ---- Start ---------------------------------------------------------------

if (!("serial" in navigator)) {
  $("unsupported").hidden = false;
  ui.connect.disabled = true;
}

navigator.serial?.addEventListener("disconnect", async (event) => {
  if (state.transport && event.target === state.transport.device && !state.busy) {
    await closePort();
    resetBoardUi("The USB cable was unplugged.");
  }
});

ui.connect.addEventListener("click", connect);
ui.disconnect.addEventListener("click", disconnect);
ui.install.addEventListener("click", install);
ui.release.addEventListener("change", () => { showNotes(); updatePlan(); });
ui.full.addEventListener("change", updatePlan);
ui.confirm.addEventListener("change", refreshInstallButton);

loadReleases().then(updatePlan);
