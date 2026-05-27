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
    history.replaceState(null, "", "#display");
  } else {
    document.exitFullscreen?.().catch(() => {});
    history.replaceState(null, "", location.pathname + location.search);
  }
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

  if (window.Html5Qrcode) {
    state.scanner = new Html5Qrcode("reader", { verbose: false });
    await state.scanner.start(
      {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      {
        fps: 15,
        qrbox: (viewfinderWidth, viewfinderHeight) => {
          const size = Math.floor(Math.min(viewfinderWidth, viewfinderHeight) * 0.88);
          return { width: size, height: size };
        },
        aspectRatio: 1.0,
        disableFlip: false
      },
      handleQrDecoded,
      () => {}
    );
  } else {
    if (!("BarcodeDetector" in window)) {
      throw new Error("QR scanner library did not load. Make sure libs/html5-qrcode.min.js is present and loaded before app.js.");
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
        width: { ideal: 1920 },
        height: { ideal: 1080 }
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
      } catch (e) {}
      state.scanTimer = requestAnimationFrame(scanLoop);
    };
    state.scanTimer = requestAnimationFrame(scanLoop);
  }

  $("startScanBtn").disabled = true;
  $("stopScanBtn").disabled = false;
}

async function stopScanner() {
  if (state.scanner) {
    await state.scanner.stop();
    state.scanner.clear();
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
$("displayModeBtn").addEventListener("click", () => toggleDisplayMode(true));
$("exitDisplayModeBtn").addEventListener("click", () => toggleDisplayMode(false));
$("startScanBtn").addEventListener("click", () => startScanner().catch(err => alert(err.message)));
$("stopScanBtn").addEventListener("click", () => stopScanner().catch(err => alert(err.message)));
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

if (location.hash === "#display" || location.pathname.endsWith("/display")) {
  toggleDisplayMode(true);
}
