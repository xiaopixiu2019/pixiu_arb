import type { onSendAsyncHookHandler } from 'fastify';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

const encode = promisify(gzip);
const paths = new Set(['/api/markets/funding-overview', '/api/markets/catalog', '/api/crossex/instruments']);

export function acceptsGzip(header: string | undefined): boolean {
  const encodings = (header ?? '').toLowerCase().split(',').map((part) => {
    const [name, ...parameters] = part.trim().split(';').map((value) => value.trim());
    const q = parameters.find((value) => value.startsWith('q='))?.slice(2) ?? '1';
    return { name, quality: /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(q) ? Number(q) : 0 };
  });
  const explicit = encodings.filter((entry) => entry.name === 'gzip');
  return (explicit.length ? explicit : encodings.filter((entry) => entry.name === '*')).some((entry) => entry.quality > 0);
}

/** Only public read-only market JSON is eligible, never credentials/account state or writes. */
export const compressPublicMarketResponse: onSendAsyncHookHandler = async (request, reply, payload) => {
  if (request.method !== 'GET' || !paths.has(request.url.split('?', 1)[0])
    || reply.hasHeader('content-encoding') || !(typeof payload === 'string' || Buffer.isBuffer(payload))) return payload;
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (bytes.length < 1024) return payload;
  const vary = String(reply.getHeader('vary') ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  if (!vary.some((v) => v.toLowerCase() === 'accept-encoding')) vary.push('Accept-Encoding');
  reply.header('vary', vary.join(', '));
  if (!acceptsGzip(request.headers['accept-encoding'])) return payload;
  try {
    const compressed = await encode(bytes, { level: 4 });
    if (compressed.length >= bytes.length) return payload;
    reply.header('content-encoding', 'gzip').header('content-length', compressed.length);
    return compressed;
  } catch (error) {
    request.log.warn({ err: error }, 'public market compression failed; serving original response');
    return payload;
  }
};
