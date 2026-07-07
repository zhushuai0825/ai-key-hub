import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultEmbeddingFunction } from '@chroma-core/default-embed';
import { env as TransformersEnv } from '@huggingface/transformers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const USE_HASH_EMBEDDING = process.env.USE_HASH_EMBEDDING === '1';
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'Xenova/bge-small-zh-v1.5';
export const EMBEDDING_BATCH_SIZE = Number(process.env.EMBEDDING_BATCH_SIZE || 12);

TransformersEnv.cacheDir = process.env.HF_CACHE_DIR || path.join(__dirname, '..', '.cache', 'hf');
TransformersEnv.allowLocalModels = true;
const hfEndpoint = process.env.HF_ENDPOINT || 'https://hf-mirror.com';
TransformersEnv.remoteHost = hfEndpoint.endsWith('/') ? hfEndpoint : `${hfEndpoint}/`;

let embedder = null;
let embedderInit = null;
let embeddingReady = false;
let embeddingError = null;

function hashEmbedding(text, dimensions = 384) {
  const vector = Array(dimensions).fill(0);
  const tokens = String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  tokens.forEach((token) => {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i += 1) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const index = Math.abs(hash) % dimensions;
    vector[index] += 1;
  });
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}

async function getTransformersEmbedder() {
  if (!embedderInit) {
    embedderInit = (async () => {
      const instance = new DefaultEmbeddingFunction({
        modelName: EMBEDDING_MODEL,
        dtype: process.env.EMBEDDING_DTYPE || 'q8',
      });
      await instance.generate(['embedding warmup']);
      embedder = instance;
      embeddingReady = true;
      embeddingError = null;
      console.log(`[embeddings] ready: ${EMBEDDING_MODEL}`);
      return instance;
    })().catch((error) => {
      embeddingReady = false;
      embeddingError = error.message;
      embedderInit = null;
      throw error;
    });
  }
  return embedderInit;
}

export async function warmupEmbeddings() {
  if (USE_HASH_EMBEDDING) {
    embeddingReady = true;
    return { mode: 'hash' };
  }
  await getTransformersEmbedder();
  return { mode: 'transformers', model: EMBEDDING_MODEL };
}

export async function embedTexts(texts = [], batchSize = EMBEDDING_BATCH_SIZE) {
  const clean = texts.map((text) => String(text || '').trim().slice(0, 4000)).filter(Boolean);
  if (!clean.length) return [];
  if (USE_HASH_EMBEDDING) return clean.map((text) => hashEmbedding(text));

  const fn = await getTransformersEmbedder();
  const vectors = [];
  for (let index = 0; index < clean.length; index += batchSize) {
    const batch = clean.slice(index, index + batchSize);
    const batchVectors = await fn.generate(batch);
    vectors.push(...batchVectors);
  }
  return vectors;
}

export async function embedQuery(text) {
  const [vector] = await embedTexts([text], 1);
  return vector || null;
}

export function getEmbeddingStatus() {
  return {
    mode: USE_HASH_EMBEDDING ? 'hash' : 'transformers',
    model: USE_HASH_EMBEDDING ? 'hash-384' : EMBEDDING_MODEL,
    ready: USE_HASH_EMBEDDING ? true : embeddingReady,
    error: embeddingError,
  };
}
