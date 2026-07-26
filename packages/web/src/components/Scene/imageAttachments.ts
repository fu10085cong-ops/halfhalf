export interface ImageAttachment {
  id: string;
  dataUri: string;
}

export interface CompactImagesResult {
  markdown: string;
  attachments: ImageAttachment[];
}

const DATA_IMAGE_RE = /data:image\/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/=]+/g;
const ATTACHMENT_RE = /halfhalf-image:\/\/([a-zA-Z0-9-]+)/g;

function attachmentId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function compactInlineImages(markdown: string): CompactImagesResult {
  const attachments: ImageAttachment[] = [];
  const compactMarkdown = markdown.replace(DATA_IMAGE_RE, (dataUri) => {
    const id = attachmentId();
    attachments.push({ id, dataUri });
    return `halfhalf-image://${id}`;
  });
  return { markdown: compactMarkdown, attachments };
}

export function expandImageAttachments(
  markdown: string,
  sources: Record<string, string>
): string {
  return markdown.replace(ATTACHMENT_RE, (placeholder, id: string) => {
    return sources[id] ?? placeholder;
  });
}

function safeImageAlt(name: string): string {
  const clean = name.replace(/[\r\n]+/g, ' ').replace(/\]/g, '\\]').trim();
  return clean ? `图片：${clean}` : '图片';
}

export function fileToImageAttachment(
  file: File
): Promise<{ snippet: string; attachment: ImageAttachment }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUri = String(reader.result ?? '');
      const id = attachmentId();
      resolve({
        snippet: `\n![${safeImageAlt(file.name)}](halfhalf-image://${id})\n`,
        attachment: { id, dataUri },
      });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
