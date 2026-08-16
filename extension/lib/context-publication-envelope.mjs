export const CONTEXT_PUBLICATION_ENVELOPE_PROTOCOL = 'hermes.browser.context-publication-envelope.v1';

const MAX_TEXT_BYTES = 1_048_576;
const MAX_IMAGE_DATA_URL_BYTES = 15_000_000;
const IMAGE_DATA_URL_RE = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/]+={0,2})$/i;

function validImageDataUrl(value) {
  const match = IMAGE_DATA_URL_RE.exec(value);
  if (!match || match[1].length % 4 !== 0) return false;
  try {
    return btoa(atob(match[1])) === match[1];
  } catch {
    return false;
  }
}

function exactOwnData(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string')) return null;
  const ownKeys = Object.keys(descriptors);
  if (ownKeys.length !== keys.length || keys.some((key) => !ownKeys.includes(key))) return null;
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function exactArrayData(value) {
  if (!Array.isArray(value)) return null;
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string')) return null;
  const lengthDescriptor = descriptors.length;
  const length = lengthDescriptor?.value;
  if (!Number.isSafeInteger(length) || length < 2 || length > 7) return null;
  const expectedKeys = [...Array.from({ length }, (_, index) => String(index)), 'length'];
  const ownKeys = Object.keys(descriptors);
  if (ownKeys.length !== expectedKeys.length || expectedKeys.some((key) => !ownKeys.includes(key))) return null;
  const result = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set) return null;
    result.push(descriptor.value);
  }
  return result;
}

function utf8Length(value) {
  return new TextEncoder().encode(value).byteLength;
}

function sanitizeContent(content) {
  if (typeof content === 'string') {
    if (!content || utf8Length(content) > MAX_TEXT_BYTES) return null;
    return content;
  }
  const entries = exactArrayData(content);
  if (!entries) return null;
  const textPart = exactOwnData(entries[0], ['type', 'text']);
  if (!textPart || textPart.type !== 'text' || typeof textPart.text !== 'string'
    || !textPart.text || utf8Length(textPart.text) > MAX_TEXT_BYTES) return null;
  const sanitized = [{ type: 'text', text: textPart.text }];
  for (const entry of entries.slice(1)) {
    const imagePart = exactOwnData(entry, ['type', 'image_url']);
    const imageUrl = imagePart && exactOwnData(imagePart.image_url, ['url', 'detail']);
    if (!imagePart || imagePart.type !== 'image_url' || !imageUrl
      || imageUrl.detail !== 'auto' || typeof imageUrl.url !== 'string'
      || utf8Length(imageUrl.url) > MAX_IMAGE_DATA_URL_BYTES
      || !validImageDataUrl(imageUrl.url)) return null;
    sanitized.push({ type: 'image_url', image_url: { url: imageUrl.url, detail: 'auto' } });
  }
  return sanitized;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function buildOutboundContent(prompt = '', attachments = []) {
  const text = String(prompt || '');
  const images = Array.isArray(attachments)
    ? attachments.filter((attachment) => attachment?.kind === 'image' && attachment.dataUrl)
    : [];
  if (!images.length) return text;
  return [
    { type: 'text', text },
    ...images.slice(0, 6).map((image) => ({
      type: 'image_url',
      image_url: { url: image.dataUrl, detail: 'auto' },
    })),
  ];
}

export async function prepareContextPublicationEnvelope(rawRequest = {}) {
  const request = exactOwnData(rawRequest, ['content']);
  const sanitizedContent = request && sanitizeContent(request.content);
  if (sanitizedContent === null) return { ok: false, reason: 'content_invalid' };
  const publication = deepFreeze({
    protocol: CONTEXT_PUBLICATION_ENVELOPE_PROTOCOL,
    content: sanitizedContent,
  });
  const canonical = stableStringify(publication);
  const contentKind = Array.isArray(publication.content) ? 'multimodal' : 'text';
  const imageCount = Array.isArray(publication.content)
    ? publication.content.filter((part) => part?.type === 'image_url').length : 0;
  return deepFreeze({
    ok: true,
    publication,
    proposal: {
      protocol: CONTEXT_PUBLICATION_ENVELOPE_PROTOCOL,
      payloadSha256: await sha256Hex(canonical),
      payloadByteLength: new TextEncoder().encode(canonical).byteLength,
      contentKind,
      imageCount,
    },
  });
}
