const $ = (id) => document.getElementById(id);

const state = {
  frames: [],
  frameIndex: 0,
  intervalId: null,
  scanner: null,
  videoStream: null,
  scanTimer: null,
  detector: null,
  received: new Map(),
  activeTransfer: null,
  rebuiltBlob: null,
  rebuiltText: ""
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

  const frames = [];
  for (let i = 0; i < dataChunks.length; i++) {
    const chunk = dataChunks[i];
    const payload = {
      qrt: "aqr-transfer",
      v: 1,
      id,
      i,
      t: dataChunks.length,
      name,
      mime,
      alg: useCompression ? "gzip" : "raw",
      fileHash,
      data: chunk,
      chunkHash: await sha256Hex(chunk)
    };
    frames.push(JSON.stringify(payload));
  }

  state.frames = frames;
  state.frameIndex = 0;

  $("encodeStats").innerHTML = `
    Original: <strong>${bytes.length.toLocaleString()}</strong> bytes<br>
    Encoded payload: <strong>${encoded.length.toLocaleString()}</strong> chars<br>
    Frames: <strong>${frames.length}</strong><br>
    Algorithm: <strong>${useCompression ? "gzip" : "raw"}</strong>
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
  wrap.appendChild(canvas);
  await QRCode.toCanvas(canvas, state.frames[state.frameIndex], {
    errorCorrectionLevel: "M",
    margin: 2,
    scale: 8
  });
  $("frameCounter").textContent = `Frame ${state.frameIndex + 1} / ${state.frames.length}`;
}

function startAnimation() {
  if (!state.frames.length) return;
  stopAnimation();
  const fps = Number($("fps").value);
  state.intervalId = setInterval(async () => {
    state.frameIndex = (state.frameIndex + 1) % state.frames.length;
    await renderCurrentFrame();
  }, 1000 / fps);
  $("stopBtn").disabled = false;
}

function stopAnimation() {
  if (state.intervalId) clearInterval(state.intervalId);
  state.intervalId = null;
  $("stopBtn").disabled = true;
}

function resetDecode() {
  state.received.clear();
  state.activeTransfer = null;
  state.rebuiltBlob = null;
  state.rebuiltText = "";
  $("decodeStats").textContent = "Waiting for QR frames.";
  $("missingChunks").textContent = "";
  $("meterBar").style.width = "0%";
  $("outputText").value = "";
  $("downloadBtn").disabled = true;
  $("copyBtn").disabled = true;
}

async function handleQrDecoded(decodedText) {
  let payload;
  try {
    payload = JSON.parse(decodedText);
  } catch {
    return;
  }

  if (payload.qrt !== "aqr-transfer" || payload.v !== 1) return;

  if (!state.activeTransfer || state.activeTransfer.id !== payload.id) {
    resetDecode();
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

  const chunkHash = await sha256Hex(payload.data);
  if (chunkHash !== payload.chunkHash) return;

  state.received.set(payload.i, payload.data);
  updateDecodeProgress();

  if (state.received.size === state.activeTransfer.total) {
    await rebuildTransfer();
  }
}

function updateDecodeProgress() {
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
    Algorithm: <strong>${meta.alg}</strong>
  `;
  $("missingChunks").textContent = missing.length ? `Missing frames: ${missing.join(", ")}` : "All frames received.";
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
  const isText = (meta.mime || "").startsWith("text/") || /\.(ts|js|json|xml|html|css|txt|md|log)$/i.test(meta.name);

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

  // Prefer html5-qrcode if someone adds it later, otherwise use the browser's native BarcodeDetector.
  if (window.Html5Qrcode) {
    state.scanner = new Html5Qrcode("reader");
    await state.scanner.start(
      { facingMode: "environment" },
      { fps: 12, qrbox: { width: 280, height: 280 } },
      handleQrDecoded,
      () => {}
    );
  } else {
    if (!("BarcodeDetector" in window)) {
      throw new Error("This browser does not support native QR scanning. On iPhone, use recent Safari/Chrome over HTTPS/Tailscale. For older browsers, add html5-qrcode locally.");
    }

    state.detector = new BarcodeDetector({ formats: ["qr_code"] });
    const video = document.createElement("video");
    video.setAttribute("playsinline", "true");
    video.muted = true;
    video.className = "scanner-video";
    reader.appendChild(video);

    state.videoStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
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
      } catch (e) {
        // Keep scanning. Camera frames can fail while the video is warming up.
      }
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
$("startScanBtn").addEventListener("click", () => startScanner().catch(err => alert(err.message)));
$("stopScanBtn").addEventListener("click", () => stopScanner().catch(err => alert(err.message)));
$("resetScanBtn").addEventListener("click", resetDecode);
$("downloadBtn").addEventListener("click", downloadRebuiltFile);
$("copyBtn").addEventListener("click", copyOutput);
