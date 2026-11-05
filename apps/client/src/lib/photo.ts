// Loading photos taken on a phone are often 4–12 MB. Shrink them in the browser before upload,
// so a dispatch with three photos stays well under the server's request limit.

export interface PhotoUpload { mime: 'image/jpeg'; data: string; preview: string; size: number }

const MAX_SIDE = 1280;
const TARGET_BYTES = 700 * 1024; // 3 photos stay under the 4.5 MB request limit on the trial host

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This file is not a photo the browser can open')); };
    img.src = url;
  });
}

const toBlob = (canvas: HTMLCanvasElement, quality: number) =>
  new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not compress the photo'))), 'image/jpeg', quality));

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('Could not read the photo'));
    r.readAsDataURL(blob);
  });
}

export async function compressPhoto(file: File): Promise<PhotoUpload> {
  if (!file.type.startsWith('image/')) throw new Error('Choose a photo (JPEG or PNG)');
  const img = await loadImage(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not compress the photo');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(img.src);
  let blob = await toBlob(canvas, 0.8);
  for (const q of [0.65, 0.5]) {
    if (blob.size <= TARGET_BYTES) break;
    blob = await toBlob(canvas, q);
  }
  return { mime: 'image/jpeg', data: await base64(blob), preview: URL.createObjectURL(blob), size: blob.size };
}
