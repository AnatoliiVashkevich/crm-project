// api.js - talks to the backend. No DOM rendering except the save indicator.
const API_BASE = "/api";
let saveTimer;

function setSave(state, msg) {
  const el = document.getElementById("saveState");
  clearTimeout(saveTimer);
  if (state === "saving") {
    el.textContent = "Saving...";
    el.className = "save saving";
  } else if (state === "saved") {
    el.textContent = "Saved ✓";
    el.className = "save saved";
    saveTimer = setTimeout(() => { el.textContent = ""; }, 2000);
  } else {
    el.textContent = "Error: " + msg;
    el.className = "save error";
  }
}

async function api(method, path, body) {
  const res = await fetch(API_BASE + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Request failed");
  return data;
}

// Auto-save used by every inline editor (one or several fields in a single PATCH).
async function saveFields(entity, id, fields) {
  setSave("saving");
  try {
    const path = entity === "profile" ? "/profile" : `/${entity}/${id}`;
    const row = await api("PATCH", path, fields);
    setSave("saved");
    return row;
  } catch (e) {
    setSave("error", e.message);
    throw e;
  }
}

const saveField = (entity, id, field, value) => saveFields(entity, id, { [field]: value });

// ---------- photos: compressed in the browser BEFORE upload ----------
// Max 1920 px on the long side, WebP (JPEG fallback) at quality 0.82. Target 250-450 KB, hard cap 500 KB:
// if a photo is still heavier, shrink the picture a little instead of lowering the quality.
const MAX_PHOTO_KB = 500;
let webpSupported = null;
const canvasToBlob = (canvas, type, q) => new Promise(res => canvas.toBlob(res, type, q));

async function compressImage(file) {
  if (webpSupported === null) {
    const probe = document.createElement("canvas");
    probe.width = probe.height = 1;
    webpSupported = (await canvasToBlob(probe, "image/webp", 0.8))?.type === "image/webp";
  }
  const type = webpSupported ? "image/webp" : "image/jpeg";
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    try { bmp = await createImageBitmap(file); } catch { throw new Error("This photo format is not supported."); }
  }
  let scale = Math.min(1, 1920 / Math.max(bmp.width, bmp.height));
  let blob;
  for (let i = 0; i < 6; i++) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    blob = await canvasToBlob(canvas, type, 0.82);
    if (blob && blob.size <= MAX_PHOTO_KB * 1024) break;
    scale *= 0.85;
  }
  if (bmp.close) bmp.close();
  if (!blob) throw new Error("Could not process this photo.");
  return blob;
}

async function uploadPhoto(entity, id, blob) {
  const fd = new FormData();
  fd.append("kind", entity);
  fd.append("row_id", id);
  fd.append("file", blob, "photo." + (blob.type === "image/webp" ? "webp" : "jpg"));
  const res = await fetch(API_BASE + "/photos", { method: "POST", body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Upload failed");
  return data.image_urls;
}
