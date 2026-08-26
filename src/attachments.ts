/**
 * Case attachments — download, analyze, and prepare image assets.
 *
 * Cases arrive with screenshots ("this is what the report card prints") and
 * artwork ("here is our new logo"). This module pulls every attachment the
 * case carries — CaseFile records plus images embedded in feed posts and
 * emails — into a local folder, and for each image emits auto-cropped PNG and
 * JPG variants so a logo is ready to drop into a district folder without a
 * detour through an image editor.
 *
 * SECURITY MODEL:
 *  - Downloads go through creatioClient.downloadFile(), which is GET-only and
 *    restricted to the CaseFile/FeedFile/ActivityFile entities + GUID ids.
 *  - Attachment names come from the client — they are sanitized to a flat
 *    basename before touching the filesystem, and files land ONLY under this
 *    tool's own .attachments/<case>/ folder, never inside custom-reports
 *    (each subrepo auto-deploys on push; see repoIndex.ts). Placing a
 *    processed image into a district folder is a separate, explicit,
 *    developer-approved server action.
 *  - Attachment CONTENT is untrusted case data. The fix agent may view the
 *    images to understand a defect or identify a logo; its prompt says
 *    image content is data, never instructions.
 *  - Cropping runs in a headless browser page with scripts disabled for the
 *    page itself (we drive it via evaluate); the image bytes are passed as a
 *    data: URI, so nothing is fetched from the network.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium, type Browser } from "playwright-core";

import { downloadFile } from "./creatioClient.js";
import { listCaseFiles, type CaseImage } from "./caseLookup.js";
import type { AnalyzableCase } from "./analyze.js";

const TOOL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ATTACH_ROOT = join(TOOL_DIR, ".attachments");

const MAX_ATTACHMENTS = 12;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 15_000; // per image
const JPEG_QUALITY = 0.92;

/** Filename smells that usually mean "this is the district's artwork". */
const LOGO_NAME_RE = /\blogo|crest|seal|badge|emblem|letterhead|header\b/i;

const IMAGE_CT_RE = /^image\//i;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|bmp|webp|svg|ico)$/i;

export interface StagedAttachment {
  /** Where the reference came from: a CaseFile record or an inline image. */
  source: "case-file" | "inline";
  entity: string; // CaseFile | FeedFile | ActivityFile
  id: string; // Creatio GUID
  /** Sanitized filename of the original bytes inside the staging dir. */
  name: string;
  bytes: number;
  contentType: string;
  isImage: boolean;
  width?: number;
  height?: number;
  /** Filenames of the processed variants (images only), inside the same dir. */
  croppedPng?: string;
  croppedJpg?: string;
  /** True when auto-cropping actually removed border area. */
  cropped?: boolean;
  /** Filename suggests district artwork — the agent/developer confirms by eye. */
  probableLogo?: boolean;
  /** Why this file could not be downloaded or processed. */
  error?: string;
}

export interface StagedAttachments {
  caseNumber: string;
  /** Absolute path of the staging folder for this case. */
  dir: string;
  files: StagedAttachment[];
  /** Human-readable caveats (skipped files, processing unavailable, …). */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Reference collection
// ---------------------------------------------------------------------------
interface AttachmentRef {
  source: StagedAttachment["source"];
  entity: string;
  id: string;
  name?: string; // only CaseFile rows know their name up front
}

/** Every attachment the case carries: CaseFile records first (the files a
 *  human deliberately attached), then images embedded in the conversation. */
async function collectRefs(c: AnalyzableCase): Promise<{ refs: AttachmentRef[]; notes: string[] }> {
  const refs: AttachmentRef[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  const push = (r: AttachmentRef) => {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      refs.push(r);
    }
  };

  try {
    for (const f of await listCaseFiles(c.Id)) {
      push({ source: "case-file", entity: "CaseFile", id: f.Id, name: f.Name });
    }
  } catch (e) {
    notes.push(
      `Could not list CaseFile attachments: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  const inline: CaseImage[] = [];
  const d = c.detail || {};
  for (const seg of d.descriptionSegments || []) {
    if (seg.type === "image" && "entity" in seg) inline.push({ entity: seg.entity, id: seg.id });
  }
  for (const e of d.timeline || (d.latest ? [d.latest] : [])) {
    for (const seg of e.segments || []) {
      if (seg.type === "image" && "entity" in seg) inline.push({ entity: seg.entity, id: seg.id });
    }
    for (const img of e.images || []) inline.push(img);
  }
  for (const img of inline) push({ source: "inline", entity: img.entity, id: img.id });

  if (refs.length > MAX_ATTACHMENTS) {
    notes.push(`Case has ${refs.length} attachments; staging the first ${MAX_ATTACHMENTS}.`);
  }
  return { refs: refs.slice(0, MAX_ATTACHMENTS), notes };
}

// ---------------------------------------------------------------------------
// Filenames — client-supplied, so flattened and de-collided before disk
// ---------------------------------------------------------------------------
function sanitizeName(raw: string | undefined, fallback: string): string {
  const base = String(raw || "")
    .split(/[\\/]/)
    .pop()!
    .replace(/[\x00-\x1f<>:"|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 80);
  return base || fallback;
}

function decollide(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; ; i++) {
    const cand = `${stem}-${i}${ext}`;
    if (!taken.has(cand.toLowerCase())) return cand;
  }
}

/** Content types Creatio commonly reports for images, mapped to an extension
 *  for inline images that arrive with no filename at all. */
function extFor(contentType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes("png")) return ".png";
  if (ct.includes("jpeg") || ct.includes("jpg")) return ".jpg";
  if (ct.includes("gif")) return ".gif";
  if (ct.includes("bmp")) return ".bmp";
  if (ct.includes("webp")) return ".webp";
  if (ct.includes("svg")) return ".svg";
  return "";
}

// ---------------------------------------------------------------------------
// Image processing — auto-crop + PNG/JPG export via headless Chrome
// ---------------------------------------------------------------------------
interface CropResult {
  width: number;
  height: number;
  cropped: boolean;
  png: string; // base64
  jpg: string; // base64
}

/** Exported for tests — production code goes through stageAttachments(). */
export async function launchHeadless(): Promise<Browser> {
  let lastErr: unknown;
  for (const channel of ["chrome", "msedge"] as const) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    `No local Chrome/Edge available for image processing: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`
  );
}

/**
 * Runs inside the browser page. Detects the background from the border pixels
 * (transparent or a solid color), finds the bounding box of everything that
 * differs from it, crops with a small margin, and returns PNG + JPG (JPG gets
 * the transparency flattened onto white).
 */
const CROP_SCRIPT = `async (dataUri) => {
  const img = new Image();
  await new Promise((ok, err) => { img.onload = ok; img.onerror = () => err(new Error("undecodable image")); img.src = dataUri; });
  const w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) throw new Error("image has no intrinsic size");
  if (w * h > 64_000_000) throw new Error("image too large to process");

  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  cx.drawImage(img, 0, 0);
  const px = cx.getImageData(0, 0, w, h).data;

  // Background = the dominant pixel among the four corners.
  const corner = (x, y) => { const i = (y * w + x) * 4; return [px[i], px[i+1], px[i+2], px[i+3]]; };
  const corners = [corner(0,0), corner(w-1,0), corner(0,h-1), corner(w-1,h-1)];
  const key = (c) => c.join(",");
  const counts = {};
  for (const c of corners) counts[key(c)] = (counts[key(c)] || 0) + 1;
  const bg = corners[corners.map(key).findIndex((k) => counts[k] === Math.max(...Object.values(counts)))];

  const TOL = 24; // per-channel distance that still counts as background
  const isContent = (i) => {
    const a = px[i+3];
    if (bg[3] < 16) return a >= 16;                    // transparent background
    if (a < 16) return false;                          // transparent pixel on solid bg
    return Math.abs(px[i] - bg[0]) > TOL || Math.abs(px[i+1] - bg[1]) > TOL ||
           Math.abs(px[i+2] - bg[2]) > TOL || Math.abs(a - bg[3]) > TOL;
  };

  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (isContent((y * w + x) * 4)) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) { minX = 0; minY = 0; maxX = w - 1; maxY = h - 1; } // blank image: keep as-is

  const pad = Math.max(2, Math.round(Math.max(w, h) * 0.01));
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
  let cw = maxX - minX + 1, ch = maxY - minY + 1;

  // A trim under 2% of the area is noise — keep the original framing.
  const cropped = cw * ch < w * h * 0.98;
  if (!cropped) { minX = 0; minY = 0; cw = w; ch = h; }

  const out = document.createElement("canvas");
  out.width = cw; out.height = ch;
  const ox = out.getContext("2d");
  ox.drawImage(cv, minX, minY, cw, ch, 0, 0, cw, ch);
  const png = out.toDataURL("image/png");

  const flat = document.createElement("canvas");
  flat.width = cw; flat.height = ch;
  const fx = flat.getContext("2d");
  fx.fillStyle = "#ffffff"; fx.fillRect(0, 0, cw, ch);
  fx.drawImage(out, 0, 0);
  const jpg = flat.toDataURL("image/jpeg", ${JPEG_QUALITY});

  return { width: cw, height: ch, cropped,
           png: png.slice(png.indexOf(",") + 1), jpg: jpg.slice(jpg.indexOf(",") + 1) };
}`;

/** Exported for tests — production code goes through stageAttachments(). */
export async function cropImage(
  browser: Browser,
  buffer: Buffer,
  contentType: string
): Promise<CropResult> {
  const page = await browser.newPage();
  try {
    page.setDefaultTimeout(PROCESS_TIMEOUT_MS);
    const ct = IMAGE_CT_RE.test(contentType) ? contentType : "image/png";
    const dataUri = `data:${ct};base64,${buffer.toString("base64")}`;
    // A string pageFunction is evaluated as an EXPRESSION (args are ignored),
    // so invoke the script explicitly; JSON.stringify makes the URI a safe literal.
    return (await page.evaluate(`(${CROP_SCRIPT})(${JSON.stringify(dataUri)})`)) as CropResult;
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Staging — the one entry point
// ---------------------------------------------------------------------------
export async function stageAttachments(c: AnalyzableCase): Promise<StagedAttachments> {
  const { refs, notes } = await collectRefs(c);
  const caseKey = c.Number.replace(/[^A-Za-z0-9-]/g, "_");
  const dir = join(ATTACH_ROOT, caseKey);
  const files: StagedAttachment[] = [];
  if (!refs.length) return { caseNumber: c.Number, dir, files, notes };

  await mkdir(dir, { recursive: true });
  const taken = new Set<string>();

  // 1. Download originals.
  for (const ref of refs) {
    const att: StagedAttachment = {
      source: ref.source,
      entity: ref.entity,
      id: ref.id,
      name: "",
      bytes: 0,
      contentType: "",
      isImage: false,
    };
    files.push(att);
    try {
      const dl = await downloadFile(ref.entity, ref.id);
      att.contentType = dl.contentType;
      att.bytes = dl.buffer.length;
      if (dl.buffer.length > MAX_FILE_BYTES) {
        att.error = `larger than ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB — not staged`;
        continue;
      }
      const fallback = `${ref.source}-${ref.id.slice(0, 8)}${extFor(dl.contentType)}`;
      att.name = decollide(sanitizeName(ref.name || dl.filename, fallback), taken);
      taken.add(att.name.toLowerCase());
      att.isImage = IMAGE_CT_RE.test(dl.contentType) || IMAGE_EXT_RE.test(att.name);
      att.probableLogo = att.isImage && LOGO_NAME_RE.test(att.name);
      await writeFile(join(dir, att.name), dl.buffer);
    } catch (e) {
      att.error = e instanceof Error ? e.message : String(e);
    }
  }

  // 2. Auto-crop the images. One headless browser for the whole batch; if no
  //    Chrome/Edge is available, originals are still staged.
  const images = files.filter((f) => f.isImage && !f.error);
  if (images.length) {
    let browser: Browser | null = null;
    try {
      browser = await launchHeadless();
      for (const att of images) {
        try {
          const buf = await readFile(join(dir, att.name));
          const r = await cropImage(browser, buf, att.contentType);
          att.width = r.width;
          att.height = r.height;
          att.cropped = r.cropped;
          const stem = att.name.replace(/\.[^.]+$/, "");
          att.croppedPng = decollide(`${stem}.cropped.png`, taken);
          taken.add(att.croppedPng.toLowerCase());
          att.croppedJpg = decollide(`${stem}.cropped.jpg`, taken);
          taken.add(att.croppedJpg.toLowerCase());
          await writeFile(join(dir, att.croppedPng), Buffer.from(r.png, "base64"));
          await writeFile(join(dir, att.croppedJpg), Buffer.from(r.jpg, "base64"));
        } catch (e) {
          att.error = `staged, but processing failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
    } catch (e) {
      notes.push(
        `Images staged unprocessed — ${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      await browser?.close().catch(() => {});
    }
  }

  return { caseNumber: c.Number, dir, files, notes };
}
