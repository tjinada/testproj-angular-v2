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
  lastDecoded: ""
};

const QR_OPTIONS = {
  errorCorrectionLevel: "H",
  margin: 6,
  scale: 12,
  color: {
    dark: "#000000",
    light: "#ffffff"
  }
};

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
  if (!err) return "Unknown scanner error.";
  if (typeof err === "string") return err;
  if (err.message) return err.message;
  if (err.name) return `${err.name}: ${err.constraint || "Camera start failed."}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function setScannerStatus(message, kind = "muted") {
  const el = $("scannerStatus");
  if (!el) return;
  el.textContent = message;
  el.className = `scanner-status ${kind}`;
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
    QR settings: <strong>ECC H, margin 6</strong>
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
  let joined = "";
  for (let i = 0; i < meta.total; i++) joined += state.received.get(i);

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

async function startScanner() {
  if (state.scanner || state.videoStream) return;

  const reader = $("reader");
  reader.innerHTML = "";
  setScannerStatus("Starting camera…", "muted");
  $("startScanBtn").disabled = true;

  try {
    if (!window.isSecureContext) {
      throw new Error("Camera access requires HTTPS, localhost, or a trusted local context. Use your Cloudflare/Tailscale HTTPS URL on the phone.");
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser does not expose camera access to this page.");
    }

    if (window.Html5Qrcode) {
      state.scanner = new Html5Qrcode("reader", { verbose: false });

      const scannerConfig = {
        fps: 10,
        qrbox: (viewfinderWidth, viewfinderHeight) => {
          const size = Math.floor(Math.min(viewfinderWidth, viewfinderHeight) * 0.88);
          return { width: size, height: size };
        },
        aspectRatio: 1.0,
        disableFlip: false
      };

      const cameraAttempts = [
        {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        { facingMode: "environment" },
        { facingMode: { ideal: "environment" } }
      ];

      let lastErr = null;
      for (const constraints of cameraAttempts) {
        try {
          await state.scanner.start(
            constraints,
            scannerConfig,
            handleQrDecoded,
            () => {}
          );
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          try {
            await state.scanner.stop();
          } catch {}
        }
      }
      if (lastErr) throw lastErr;
    } else {
      if (!("BarcodeDetector" in window)) {
        throw new Error("QR scanner library did not load. Confirm /libs/html5-qrcode.min.js returns 200 and loads before app.js.");
      }

      state.detector = new BarcodeDetector({ formats: ["qr_code"] });
      const video = document.createElement("video");
      video.setAttribute("playsinline", "true");
      video.muted = true;
      video.className = "scanner-video";
      reader.appendChild(video);

      state.videoStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });
      video.srcObject = state.videoStream;
      await video.play();

      const scanLoop = async () => {
        if (!state.videoStream) return;
        try {
          const codes = await state.detector.detect(video);
          for (const code of codes) {
            if (code.rawValue) await handleQrDecoded(code.rawValue);
          }
        } catch {}
        state.scanTimer = requestAnimationFrame(scanLoop);
      };
      state.scanTimer = requestAnimationFrame(scanLoop);
    }

    $("stopScanBtn").disabled = false;
    setScannerStatus("Camera running. Point it at the QR code and keep the QR inside the square.", "ok");
  } catch (err) {
    const message = errorToMessage(err);
    await stopScanner({ silent: true });
    setScannerStatus(message, "error");
    throw new Error(message);
  }
}


async function stopScanner(options = {}) {
  if (state.scanner) {
    try {
      await state.scanner.stop();
    } catch {}
    try {
      state.scanner.clear();
    } catch {}
    state.scanner = null;
  }

  if (state.scanTimer) {
    cancelAnimationFrame(state.scanTimer);
    state.scanTimer = null;
  }

  if (state.videoStream) {
    state.videoStream.getTracks().forEach(track => track.stop());
    state.videoStream = null;
  }

  $("reader").innerHTML = "";
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
$("startScanBtn").addEventListener("click", () => startScanner().catch(err => alert(errorToMessage(err))));
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

if (location.hash === "#display") {
  // Clean up old bookmarked/hash state from earlier builds.
  history.replaceState(null, "", location.pathname + location.search);
}
if (wantsDisplayMode()) {
  toggleDisplayMode(true);
}
