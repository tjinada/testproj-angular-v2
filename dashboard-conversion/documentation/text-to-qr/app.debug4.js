const BUILD_ID = "debug5-2026-05-27";
const $ = (id) => document.getElementById(id);

const state = {
  frames: [],
  frameIndex: 0,
  holdTick: 0,
  intervalId: null,
  scanner: null,
  videoStream: null,
  scanTimer: null,
  detector: null,
  received: new Map(),
  activeTransfer: null,
  rebuiltBlob: null,
  rebuiltText: "",
  displayMode: false,
  lastDecoded: "",
  scanStarting: false
};

const QR_OPTIONS = {
  // ECC M (15%) is plenty for screen->camera transfer. ECC H was designed for
  // damaged printed surfaces and just makes the QR denser for no real benefit.
  errorCorrectionLevel: "M",
  // CSS border on .qr-wrap canvas already provides visual quiet zone, so we
  // only need the minimum 2-module quiet zone the QR spec requires.
  margin: 2,
  scale: 10,
  color: {
    dark: "#000000",
    light: "#ffffff"
  }
};

const DEBUG = true;

function safeStringify(value) {
  try {
    if (value instanceof Error) {
      return JSON.stringify({
        name: value.name,
        message: value.message,
        stack: value.stack
      }, null, 2);
    }
    if (typeof value === "string") return value;
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatError(error) {
  if (!error) return "Unknown error. The browser returned an empty error object.";
  if (typeof error === "string") return error;
  if (error.message) return error.message;
  if (error.name) return `${error.name}${error.constraint ? `: ${error.constraint}` : ""}`;
  return safeStringify(error);
}

function debugLog(message, data) {
  if (!DEBUG) return;

  const line = data === undefined
    ? `[${new Date().toLocaleTimeString()}] ${message}`
    : `[${new Date().toLocaleTimeString()}] ${message} ${safeStringify(data)}`;

  console.log(line);

  const el = $("debugLog");
  if (el) {
    el.textContent += `${line}\n`;
    el.scrollTop = el.scrollHeight;
  }
}

window.addEventListener("error", (event) => {
  debugLog("window.error", {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    error: formatError(event.error)
  });
});

window.addEventListener("unhandledrejection", (event) => {
  debugLog("unhandledrejection", formatError(event.reason));
  setScannerStatus(`Unhandled promise rejection: ${formatError(event.reason)}`, "error");
});

function base64UrlEncode(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeString(str) {
  return base64UrlEncode(new TextEncoder().encode(str || ""));
}

function decodeString(str) {
  return new TextDecoder().decode(base64UrlDecode(str || ""));
}

async function sha256Hex(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function splitString(str, size) {
  const chunks = [];
  for (let i = 0; i < str.length; i += size) chunks.push(str.slice(i, i + size));
  return chunks;
}

function randomId() {
  return crypto.getRandomValues(new Uint8Array(6)).reduce((acc, b) => acc + b.toString(36).padStart(2, "0"), "").slice(0, 10);
}

function errorToMessage(err) {
  return formatError(err);
}

function setScannerStatus(message, kind = "muted") {
  const el = $("scannerStatus");
  if (!el) return;
  el.textContent = message;
  el.className = `scanner-status ${kind}`;
  debugLog("scannerStatus", { message, kind });
}

function wantsDisplayMode() {
  const params = new URLSearchParams(location.search);
  return params.get("mode") === "display" || location.pathname.endsWith("/display");
}

function buildDisplayUrl() {
  const url = new URL(location.href);
  // Works for http(s) and file://. For Docker, nginx also supports /display, but
  // query mode is safer for double-clicked offline index.html.
  url.pathname = url.pathname.endsWith("/display") ? url.pathname.replace(/\/display$/, "/") : url.pathname;
  url.hash = "";
  url.searchParams.set("mode", "display");
  return url.href;
}

function switchTab(tabName) {
  document.querySelectorAll(".tab").forEach(btn => btn.classList.toggle("active", btn.dataset.tab === tabName));
  document.querySelectorAll(".panel").forEach(panel => panel.classList.toggle("active", panel.id === tabName));
}

async function readInput() {
  const file = $("fileInput").files[0];
  if (file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return {
      bytes,
      name: file.name || "transfer.bin",
      mime: file.type || "application/octet-stream"
    };
  }

  const text = $("textInput").value;
  if (!text.trim()) throw new Error("Paste text or choose a file first.");
  const name = $("fileName").value.trim() || "transfer.txt";
  return {
    bytes: new TextEncoder().encode(text),
    name,
    mime: "text/plain;charset=utf-8"
  };
}

function buildCompactFrame({ id, index, total, alg, fileHash, chunkHash, name, mime, data }) {
  // Compact pipe format. data/name/mime are base64url, so they never contain pipes.
  // AQR1|id|index|total|alg|fileHash|chunkHash|nameB64|mimeB64|data
  return [
    "AQR1",
    id,
    index,
    total,
    alg,
    fileHash,
    chunkHash,
    encodeString(name),
    encodeString(mime),
    data
  ].join("|");
}

function parseFrame(decodedText) {
  if (decodedText.startsWith("AQR1|")) {
    const parts = decodedText.split("|");
    if (parts.length !== 10) return null;
    const [, id, i, t, alg, fileHash, chunkHash, nameB64, mimeB64, data] = parts;
    return {
      qrt: "aqr-transfer",
      v: 2,
      id,
      i: Number(i),
      t: Number(t),
      alg,
      fileHash,
      chunkHash,
      name: decodeString(nameB64),
      mime: decodeString(mimeB64),
      data
    };
  }

  // Backward compatibility with the earlier JSON frames.
  try {
    return JSON.parse(decodedText);
  } catch {
    return null;
  }
}

async function generateFrames() {
  stopAnimation();
  const { bytes, name, mime } = await readInput();
  const useCompression = $("useCompression").checked;
  const processedBytes = useCompression ? pako.gzip(bytes) : bytes;
  const encoded = base64UrlEncode(processedBytes);
  const chunkSize = Number($("chunkSize").value);
  const dataChunks = splitString(encoded, chunkSize);
  const id = randomId();
  const fileHash = await sha256Hex(bytes);
  const alg = useCompression ? "gzip" : "raw";

  const frames = [];
  for (let i = 0; i < dataChunks.length; i++) {
    const chunk = dataChunks[i];
    const chunkHash = (await sha256Hex(chunk)).slice(0, 16);
    frames.push(buildCompactFrame({
      id,
      index: i,
      total: dataChunks.length,
      alg,
      fileHash,
      chunkHash,
      name,
      mime,
      data: chunk
    }));
  }

  state.frames = frames;
  state.frameIndex = 0;
  state.holdTick = 0;

  const largest = Math.max(...frames.map(f => f.length));
  $("encodeStats").innerHTML = `
    Original: <strong>${bytes.length.toLocaleString()}</strong> bytes<br>
    Encoded payload: <strong>${encoded.length.toLocaleString()}</strong> chars<br>
    Frames: <strong>${frames.length}</strong><br>
    Largest QR payload: <strong>${largest.toLocaleString()}</strong> chars<br>
    Algorithm: <strong>${alg}</strong><br>
    QR settings: <strong>ECC M, margin 2</strong>
  `;
  $("transferId").textContent = `Transfer ID: ${id}`;

  await renderCurrentFrame();
  startAnimation();
}

async function renderCurrentFrame() {
  const wrap = $("qrCanvasWrap");
  wrap.innerHTML = "";
  if (!state.frames.length) {
    wrap.textContent = "QR frames will appear here";
    wrap.classList.add("empty");
    return;
  }

  wrap.classList.remove("empty");
  const canvas = document.createElement("canvas");
  canvas.className = "qr-canvas";
  wrap.appendChild(canvas);
  await QRCode.toCanvas(canvas, state.frames[state.frameIndex], QR_OPTIONS);
  $("frameCounter").textContent = `Frame ${state.frameIndex + 1} / ${state.frames.length}`;
}

function advanceFrame() {
  const hold = Number($("frameHold").value || 1);
  state.holdTick += 1;
  if (state.holdTick >= hold) {
    state.holdTick = 0;
    state.frameIndex = (state.frameIndex + 1) % state.frames.length;
  }
  renderCurrentFrame();
}

function startAnimation() {
  if (!state.frames.length) return;
  stopAnimation();
  const fps = Number($("fps").value);
  state.intervalId = setInterval(advanceFrame, 1000 / fps);
  $("stopBtn").disabled = false;
  $("pausePlayBtn").textContent = "Pause";
}

function stopAnimation() {
  if (state.intervalId) clearInterval(state.intervalId);
  state.intervalId = null;
  $("stopBtn").disabled = true;
  if ($("pausePlayBtn")) $("pausePlayBtn").textContent = "Play";
}

function togglePausePlay() {
  if (!state.frames.length) return;
  if (state.intervalId) stopAnimation();
  else startAnimation();
}

async function previousFrame() {
  if (!state.frames.length) return;
  stopAnimation();
  state.frameIndex = (state.frameIndex - 1 + state.frames.length) % state.frames.length;
  await renderCurrentFrame();
}

async function nextFrame() {
  if (!state.frames.length) return;
  stopAnimation();
  state.frameIndex = (state.frameIndex + 1) % state.frames.length;
  await renderCurrentFrame();
}

function toggleDisplayMode(force) {
  state.displayMode = typeof force === "boolean" ? force : !state.displayMode;
  document.body.classList.toggle("display-mode", state.displayMode);

  if (state.displayMode) {
    document.documentElement.requestFullscreen?.().catch(() => {});
    // Do not use #display anymore. A leftover hash caused the app to keep
    // booting into display mode after refresh.
    const url = new URL(location.href);
    url.hash = "";
    url.searchParams.set("mode", "display");
    history.replaceState(null, "", url.href);
  } else {
    document.exitFullscreen?.().catch(() => {});
    const url = new URL(location.href);
    url.hash = "";
    url.searchParams.delete("mode");
    if (url.pathname.endsWith("/display")) url.pathname = url.pathname.replace(/\/display$/, "/");
    history.replaceState(null, "", url.href);
  }
}

function openDisplayMode() {
  // Same window is best for file:// use and keeps generated QR frames in memory.
  toggleDisplayMode(true);
}


function resetDecode() {
  state.received.clear();
  state.activeTransfer = null;
  state.rebuiltBlob = null;
  state.rebuiltText = "";
  state.lastDecoded = "";
  $("decodeStats").textContent = "Waiting for QR frames.";
  $("missingChunks").textContent = "";
  $("meterBar").style.width = "0%";
  $("outputText").value = "";
  $("downloadBtn").disabled = true;
  $("copyBtn").disabled = true;
}

async function handleQrDecoded(decodedText) {
  if (!decodedText || decodedText === state.lastDecoded) return;
  state.lastDecoded = decodedText;

  const payload = parseFrame(decodedText);
  if (!payload || payload.qrt !== "aqr-transfer") return;
  if (!Number.isInteger(payload.i) || !Number.isInteger(payload.t) || payload.i < 0 || payload.i >= payload.t) return;

  if (!state.activeTransfer || state.activeTransfer.id !== payload.id) {
    resetDecode();
    state.lastDecoded = decodedText;
    state.activeTransfer = {
      id: payload.id,
      total: payload.t,
      name: payload.name,
      mime: payload.mime,
      alg: payload.alg,
      fileHash: payload.fileHash
    };
  }

  if (payload.id !== state.activeTransfer.id) return;
  if (state.received.has(payload.i)) return;

  const chunkHash = (await sha256Hex(payload.data)).slice(0, 16);
  if (chunkHash !== payload.chunkHash) return;

  state.received.set(payload.i, payload.data);
  updateDecodeProgress(payload.i);

  if (state.received.size === state.activeTransfer.total) {
    await rebuildTransfer();
  }
}

function summarizeMissing(missing) {
  if (!missing.length) return "All frames received.";
  if (missing.length <= 30) return `Missing frames: ${missing.join(", ")}`;
  return `Missing ${missing.length} frames. First missing: ${missing.slice(0, 30).join(", ")}...`;
}

function updateDecodeProgress(lastFrame) {
  const meta = state.activeTransfer;
  if (!meta) return;
  const got = state.received.size;
  const pct = Math.round((got / meta.total) * 100);
  $("meterBar").style.width = `${pct}%`;

  const missing = [];
  for (let i = 0; i < meta.total; i++) if (!state.received.has(i)) missing.push(i + 1);

  $("decodeStats").innerHTML = `
    Transfer ID: <strong>${meta.id}</strong><br>
    File: <strong>${meta.name}</strong><br>
    Chunks: <strong>${got} / ${meta.total}</strong><br>
    Last captured: <strong>${typeof lastFrame === "number" ? lastFrame + 1 : "-"}</strong><br>
    Algorithm: <strong>${meta.alg}</strong>
  `;
  $("missingChunks").textContent = summarizeMissing(missing);
}

async function rebuildTransfer() {
  const meta = state.activeTransfer;
  // Build via array + join to avoid O(n^2) string concat on large transfers.
  const parts = new Array(meta.total);
  for (let i = 0; i < meta.total; i++) parts[i] = state.received.get(i);
  const joined = parts.join("");

  let bytes = base64UrlDecode(joined);
  if (meta.alg === "gzip") bytes = pako.ungzip(bytes);

  const finalHash = await sha256Hex(bytes);
  if (finalHash !== meta.fileHash) {
    $("missingChunks").textContent = "Checksum failed. Keep scanning or reset and try again.";
    return;
  }

  state.rebuiltBlob = new Blob([bytes], { type: meta.mime || "application/octet-stream" });
  const isText = (meta.mime || "").startsWith("text/") || /\.(ts|tsx|js|jsx|json|xml|html|css|txt|md|log|yaml|yml)$/i.test(meta.name);

  if (isText) {
    state.rebuiltText = new TextDecoder().decode(bytes);
    $("outputText").value = state.rebuiltText;
    $("copyBtn").disabled = false;
  } else {
    $("outputText").value = "Binary file rebuilt. Use Download Rebuilt File.";
  }

  $("downloadBtn").disabled = false;
  $("decodeStats").innerHTML += `<br><span class="ok">Checksum passed. Transfer complete.</span>`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function createAndStartHtml5Scanner(cameraConfig, scannerConfig) {
  const reader = $("reader");
  reader.innerHTML = "";

  const scanner = new Html5Qrcode("reader", { verbose: true });
  state.scanner = scanner;

  await scanner.start(
    cameraConfig,
    scannerConfig,
    (decodedText) => {
      debugLog("QR decoded", decodedText ? decodedText.slice(0, 160) : decodedText);
      Promise.resolve(handleQrDecoded(decodedText)).catch((decodeErr) => {
        debugLog("handleQrDecoded failed", decodeErr);
        setScannerStatus(`QR decode handler failed: ${formatError(decodeErr)}`, "error");
      });
    },
    () => {}
  );

  return scanner;
}

async function cleanupScannerAfterFailedStart() {
  const scanner = state.scanner;
  state.scanner = null;

  if (!scanner) return;

  try {
    // If start() failed, html5-qrcode may be in STARTING/TRANSITION.
    // Calling stop() during that state causes "Cannot transition to a new state".
    // Give it a breath, then clear. If clear fails, ignore and recreate a fresh instance.
    await sleep(350);
    await scanner.clear();
    debugLog("Cleared scanner instance after failed start");
  } catch (clearErr) {
    debugLog("Clear after failed start ignored", clearErr);
  }

  const reader = $("reader");
  if (reader) reader.innerHTML = "";
  await sleep(350);
}

async function startScanner() {
  debugLog("Start Camera Scan clicked", {
    build: BUILD_ID,
    secureContext: window.isSecureContext,
    protocol: location.protocol,
    userAgent: navigator.userAgent,
    hasMediaDevices: !!navigator.mediaDevices,
    hasGetUserMedia: !!navigator.mediaDevices?.getUserMedia,
    hasHtml5Qrcode: !!window.Html5Qrcode,
    hasBarcodeDetector: "BarcodeDetector" in window,
    scanStarting: state.scanStarting,
    hasScanner: !!state.scanner
  });

  if (state.scanStarting) {
    debugLog("Scanner start already in progress, ignoring duplicate click");
    return;
  }

  if (state.scanner || state.videoStream) {
    debugLog("Scanner already active, ignoring start click");
    return;
  }

  const reader = $("reader");
  if (!reader) {
    const message = "Scanner container #reader was not found in the page.";
    debugLog("Scanner startup failed", message);
    setScannerStatus(message, "error");
    return;
  }

  state.scanStarting = true;
  reader.innerHTML = "";
  setScannerStatus("Starting camera…", "muted");
  $("startScanBtn").disabled = true;
  $("stopScanBtn").disabled = true;

  try {
    if (!window.isSecureContext) {
      throw new Error("Camera access requires HTTPS, localhost, or a trusted local context. Use your Cloudflare/Tailscale HTTPS URL on the phone.");
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser does not expose camera access to this page. Try Safari on iPhone, and confirm camera permission is allowed for this site.");
    }

    if (!window.Html5Qrcode) {
      throw new Error("Html5Qrcode library is not loaded. Confirm libs/html5-qrcode.min.js loads before app.js and returns JavaScript, not a 404 page.");
    }

    let cameras = [];
    try {
      cameras = await Html5Qrcode.getCameras();
      debugLog("Html5Qrcode.getCameras result", cameras);
    } catch (cameraErr) {
      debugLog("Html5Qrcode.getCameras failed. Will try facingMode fallback.", cameraErr);
    }

    const scannerConfig = {
      // Lower fps = fewer but cleaner decode attempts. Counterintuitively this
      // detects faster on phones because each grab is sharper and the main
      // thread isn't saturated mid-decode.
      fps: 4,
      qrbox: (viewfinderWidth, viewfinderHeight) => {
        // Tighter scan box (70% vs 88%) prompts the user to fill the box with
        // the QR, which means the decoder works on a higher-resolution crop.
        const size = Math.floor(Math.min(viewfinderWidth, viewfinderHeight) * 0.70);
        return { width: Math.max(220, size), height: Math.max(220, size) };
      },
      aspectRatio: 1.0,
      // Scanning a screen, not a mirror, so skip mirror-flipped decode attempts.
      disableFlip: true,
      // Use native BarcodeDetector where available (Chrome, recent Safari).
      // Native decoding is much faster than the ZXing JS port and more robust
      // to motion blur and angle. html5-qrcode falls back automatically on
      // browsers without it.
      experimentalFeatures: {
        useBarcodeDetector: true
      }
    };

    const cameraAttempts = [];

    if (Array.isArray(cameras) && cameras.length) {
      const backCamera =
        cameras.find(c => /back|rear|environment/i.test(c.label || "")) ||
        cameras[cameras.length - 1];

      debugLog("Selected camera from list", backCamera);
      // Html5Qrcode is most reliable when device ID is passed as a plain string.
      cameraAttempts.push({ label: "camera-id-string", config: backCamera.id });
    }

    // Keep fallbacks minimal. Repeated starts on the same Html5Qrcode instance caused
    // the "already under transition" error on iOS/Chrome.
    cameraAttempts.push(
      { label: "facingMode-environment", config: { facingMode: "environment" } },
      { label: "facingMode-ideal-environment", config: { facingMode: { ideal: "environment" } } }
    );

    let lastErr = null;

    for (const attempt of cameraAttempts) {
      try {
        debugLog("Trying camera start", attempt);
        await createAndStartHtml5Scanner(attempt.config, scannerConfig);
        lastErr = null;
        debugLog("Scanner started successfully", attempt);
        break;
      } catch (err) {
        lastErr = err;
        debugLog("Camera start attempt failed", {
          attempt,
          error: formatError(err),
          raw: safeStringify(err)
        });
        await cleanupScannerAfterFailedStart();
      }
    }

    if (lastErr) throw lastErr;

    state.scanStarting = false;
    $("stopScanBtn").disabled = false;
    $("startScanBtn").disabled = true;
    setScannerStatus("Camera running. Point it at the QR code and keep the QR inside the square.", "ok");
  } catch (err) {
    const message = formatError(err);
    debugLog("Scanner startup failed", { message, raw: safeStringify(err) });

    state.scanStarting = false;
    await stopScanner({ silent: true, force: true });
    $("startScanBtn").disabled = false;
    $("stopScanBtn").disabled = true;
    setScannerStatus(`Camera failed: ${message}`, "error");
  }
}

async function stopScanner(options = {}) {
  debugLog("stopScanner called", options);

  state.scanStarting = false;

  if (state.scanner) {
    const scanner = state.scanner;
    state.scanner = null;

    try {
      if (!options.force) {
        await scanner.stop();
        debugLog("Scanner stopped");
      }
    } catch (stopErr) {
      debugLog("Scanner stop ignored", stopErr);
    }

    try {
      await scanner.clear();
      debugLog("Scanner cleared");
    } catch (clearErr) {
      debugLog("Scanner clear ignored", clearErr);
    }
  }

  if (state.scanTimer) {
    cancelAnimationFrame(state.scanTimer);
    state.scanTimer = null;
  }

  if (state.videoStream) {
    state.videoStream.getTracks().forEach(track => track.stop());
    state.videoStream = null;
  }

  const reader = $("reader");
  if (reader) reader.innerHTML = "";
  $("startScanBtn").disabled = false;
  $("stopScanBtn").disabled = true;
  if (!options.silent) setScannerStatus("Scanner stopped.", "muted");
}

function downloadRebuiltFile() {
  if (!state.rebuiltBlob || !state.activeTransfer) return;
  const url = URL.createObjectURL(state.rebuiltBlob);
  const a = document.createElement("a");
  a.href = url;
  a.download = state.activeTransfer.name || "rebuilt-file";
  a.click();
  URL.revokeObjectURL(url);
}

async function copyOutput() {
  if (!state.rebuiltText) return;
  await navigator.clipboard.writeText(state.rebuiltText);
  $("copyBtn").textContent = "Copied";
  setTimeout(() => $("copyBtn").textContent = "Copy Text", 900);
}

for (const btn of document.querySelectorAll(".tab")) {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
}

$("fileInput").addEventListener("change", () => {
  const file = $("fileInput").files[0];
  if (file) $("fileName").value = file.name;
});
$("generateBtn").addEventListener("click", () => generateFrames().catch(err => alert(err.message)));
$("stopBtn").addEventListener("click", stopAnimation);
$("pausePlayBtn").addEventListener("click", togglePausePlay);
$("prevFrameBtn").addEventListener("click", previousFrame);
$("nextFrameBtn").addEventListener("click", nextFrame);
$("displayModeBtn").addEventListener("click", openDisplayMode);
$("exitDisplayModeBtn").addEventListener("click", () => toggleDisplayMode(false));
$("startScanBtn").addEventListener("click", () => startScanner());
$("stopScanBtn").addEventListener("click", () => stopScanner().catch(err => alert(errorToMessage(err))));
$("resetScanBtn").addEventListener("click", resetDecode);
$("downloadBtn").addEventListener("click", downloadRebuiltFile);
$("copyBtn").addEventListener("click", copyOutput);

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.displayMode) toggleDisplayMode(false);
  if (event.key === "ArrowLeft") previousFrame();
  if (event.key === "ArrowRight") nextFrame();
  if (event.key === " " && document.activeElement?.tagName !== "TEXTAREA") {
    event.preventDefault();
    togglePausePlay();
  }
});


debugLog("App boot", {
  build: BUILD_ID,
  href: location.href,
  secureContext: window.isSecureContext,
  hasQRCode: !!window.QRCode,
  hasPako: !!window.pako,
  hasHtml5Qrcode: !!window.Html5Qrcode,
  hasMediaDevices: !!navigator.mediaDevices,
  hasGetUserMedia: !!navigator.mediaDevices?.getUserMedia
});

if (location.hash === "#display") {
  // Clean up old bookmarked/hash state from earlier builds.
  history.replaceState(null, "", location.pathname + location.search);
}
if (wantsDisplayMode()) {
  toggleDisplayMode(true);
}
