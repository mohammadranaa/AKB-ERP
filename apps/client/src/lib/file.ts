// Proof of payment (IBFT screenshot, deposit slip, bank advice): a photo is shrunk in the browser,
// a PDF is sent as it is. The server checks the bytes again and refuses anything over 3 MB.
import { compressPhoto } from './photo';

export interface ProofUpload { mime: 'image/jpeg' | 'application/pdf'; data: string; name: string; size: number; preview?: string }

const MAX = 3 * 1024 * 1024;

function base64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('Could not read the file'));
    r.readAsDataURL(file);
  });
}

export async function readProof(file: File): Promise<ProofUpload> {
  if (file.type === 'application/pdf') {
    if (file.size > MAX) throw new Error('The PDF is over 3 MB. Save a smaller copy or a screenshot of the page.');
    return { mime: 'application/pdf', data: await base64(file), name: file.name, size: file.size };
  }
  if (file.type.startsWith('image/')) {
    const p = await compressPhoto(file);
    return { mime: 'image/jpeg', data: p.data, name: file.name, size: p.size, preview: p.preview };
  }
  throw new Error('Choose a photo, a screenshot or a PDF');
}
