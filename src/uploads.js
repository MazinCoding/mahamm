import path from 'node:path';
import multer from 'multer';
import { fileTypeFromBuffer } from 'file-type';
import { csrfProtection } from './auth.js';
import { HttpError } from './services/tasks.js';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

// Allowed by content (magic bytes), not by the name the browser sends.
const ATTACHMENT_TYPES = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

// Only these routes may receive multipart bodies; the CSRF check runs right
// after the body is parsed. Any other multipart request is refused.
export const MULTIPART_ROUTES = [/^\/tasks$/, /^\/tasks\/\d{1,9}\/attachments$/, /^\/import$/];

export function rejectUnexpectedMultipart(req, res, next) {
  if (!req.is('multipart/form-data')) return next();
  if (req.method === 'POST' && MULTIPART_ROUTES.some((re) => re.test(req.path))) return next();
  return next(new HttpError(415, 'unexpected upload'));
}

export function uploadThenCsrf(maxBytes) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 60, fieldSize: 64 * 1024, parts: 70 },
  }).single('file');
  return [upload, csrfProtection];
}

export function safeFilename(name, ext) {
  let base = path.basename(String(name || 'file'));
  // eslint-disable-next-line no-control-regex
  base = base.replace(/[\u0000-\u001F\u007F/\\:*?"<>|]/g, '_').replace(/^\.+/, '').trim() || 'file';
  const stem = base.replace(/\.[^.]*$/, '').slice(0, 120) || 'file';
  return `${stem}.${ext}`;
}

// Throws HttpError(400) unless the file's real content is an allowed type.
export async function checkAttachment(file) {
  if (!file || !file.buffer || file.buffer.length === 0) return null;
  const detected = await fileTypeFromBuffer(file.buffer);
  if (!detected || !ATTACHMENT_TYPES[detected.ext]) throw new HttpError(400, 'file type not allowed');
  return { filename: safeFilename(file.originalname, detected.ext), mime: ATTACHMENT_TYPES[detected.ext], buffer: file.buffer };
}
