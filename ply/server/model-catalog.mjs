const freezePreset = (name, baseUrl, kind) => Object.freeze({ name, baseUrl, kind });

export const MODEL_PROVIDER_PRESETS = Object.freeze({
  deepinfra: freezePreset('DeepInfra', 'https://api.deepinfra.com/v1/openai', 'openai'),
  openai: freezePreset('OpenAI', 'https://api.openai.com/v1', 'openai'),
  anthropic: freezePreset('Anthropic', 'https://api.anthropic.com/v1', 'anthropic'),
  compatible: freezePreset('OpenAI compatible', 'http://127.0.0.1:1234/v1', 'openai'),
  ollama: freezePreset('Ollama', 'http://127.0.0.1:11434', 'ollama'),
});

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 3000;
const MAX_PAGES = 3;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function validBaseUrl(value, fallback) {
  if (value != null && typeof value !== 'string') throw new Error('Enter a complete API base URL.');
  let url;
  try { url = new URL(value?.trim() || fallback); }
  catch { throw new Error('Enter a complete API base URL.'); }
  if (url.href.length > 2048 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTP or HTTPS API base URL without credentials, query, or fragment.');
  }
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) throw new Error('Remote API connections require HTTPS.');
  return url.href.replace(/\/+$/, '');
}

function validKey(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Enter a valid provider API key.');
  return value.trim();
}

function catalogEndpoint(baseUrl, kind) {
  if (kind === 'ollama') return baseUrl.endsWith('/api') ? `${baseUrl}/tags` : `${baseUrl}/api/tags`;
  return `${baseUrl}/models`;
}

function isDeepInfraChatModel(model) {
  const tags = [...(Array.isArray(model.metadata?.tags) ? model.metadata.tags : []), ...(Array.isArray(model.tags) ? model.tags : [])];
  const chatTypes = new Set(['chat', 'text-generation', 'text_generation', 'conversational']);
  if (tags.length) return tags.some(tag => typeof tag === 'string' && chatTypes.has(tag.toLowerCase()));
  const task = model.type || model.task || model.pipeline_tag || model.metadata?.type;
  // The generic "model" object type carries no task information.
  if (typeof task === 'string' && task !== 'model') return chatTypes.has(task.toLowerCase());
  return true;
}

function normalizedModel(model, provider, key) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) return null;
  if (provider === 'deepinfra' && !isDeepInfraChatModel(model)) return null;
  const rawId = provider === 'ollama' ? model.model || model.name : model.id;
  if (typeof rawId !== 'string') return null;
  const id = rawId.trim();
  if (!id || id.length > 512 || /[\u0000-\u0020\u007f]/.test(id) || (key && id.includes(key))) return null;
  const rawName = model.display_name || model.name;
  let name = typeof rawName === 'string' ? rawName.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) : '';
  if (key && name.includes(key)) name = '';
  return { id, name: name || id };
}

async function boundedJson(response) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel();
    throw new Error('The provider model catalog exceeded the 2 MB response limit.');
  }
  if (!response.body) throw new Error('The provider returned an empty model catalog.');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) {
        await reader.cancel();
        throw new Error('The provider model catalog exceeded the 2 MB response limit.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); }
  catch { throw new Error('The provider returned an invalid model catalog.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('The provider returned an invalid model catalog.');
  return data;
}

/** Discover metadata only. API keys remain in this request and are never part of the result. */
export async function discoverModels({ provider, baseUrl, apiKey, signal } = {}) {
  if (typeof provider !== 'string' || !Object.hasOwn(MODEL_PROVIDER_PRESETS, provider)) throw new Error('Choose a supported model provider.');
  const preset = MODEL_PROVIDER_PRESETS[provider];
  const normalizedBase = validBaseUrl(baseUrl, preset.baseUrl);
  const key = validKey(apiKey);
  if (key && normalizedBase.includes(key)) throw new Error('Keep the API key in the key field, separate from the API base URL.');
  const headers = { Accept: 'application/json' };
  if (preset.kind === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
    if (key) headers['x-api-key'] = key;
  } else if (key && preset.kind !== 'ollama') headers.Authorization = `Bearer ${key}`;

  const controller = new AbortController();
  const cancel = () => controller.abort(new DOMException('Model discovery cancelled.', 'AbortError'));
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Model discovery timed out after 10 seconds.', 'TimeoutError')), 10_000);
  timer.unref?.();
  const models = new Map();
  let after;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      controller.signal.throwIfAborted();
      const url = new URL(catalogEndpoint(normalizedBase, preset.kind));
      if (preset.kind === 'anthropic') {
        url.searchParams.set('limit', '1000');
        if (after) url.searchParams.set('after_id', after);
      }
      let response;
      try { response = await fetch(url, { method: 'GET', headers, redirect: 'error', signal: controller.signal }); }
      catch {
        controller.signal.throwIfAborted();
        throw new Error(`Could not reach ${preset.name}. Check the exact API base URL and connection${provider === 'ollama' ? ', and start Ollama' : ''}.`);
      }
      if (!response.ok) {
        await response.body?.cancel();
        if ([401, 403].includes(response.status)) throw new Error(`${preset.name} denied access (HTTP ${response.status}). Check your API key and account access.`);
        if (response.status === 404) throw new Error(`${preset.name} could not find the models endpoint (HTTP 404). Check the API base URL.`);
        if (response.status === 429) throw new Error(`${preset.name} rate limited model discovery (HTTP 429). Try again shortly.`);
        throw new Error(`${preset.name} could not list models (HTTP ${response.status}). Try again later.`);
      }
      let data;
      try { data = await boundedJson(response); }
      catch (error) { controller.signal.throwIfAborted(); throw error; }
      const entries = preset.kind === 'ollama' ? data.models : data.data;
      if (!Array.isArray(entries)) throw new Error(`${preset.name} returned an unrecognized model catalog.`);
      for (const entry of entries) {
        const model = normalizedModel(entry, provider, key);
        if (model && !models.has(model.id)) models.set(model.id, model);
        if (models.size >= MAX_MODELS) break;
      }
      if (preset.kind !== 'anthropic' || !data.has_more || models.size >= MAX_MODELS) break;
      const next = typeof data.last_id === 'string' ? data.last_id : entries.at(-1)?.id;
      if (typeof next !== 'string' || !next || next.length > 512 || /[\u0000-\u001f\u007f]/.test(next) || next === after || (key && next.includes(key))) {
        throw new Error('Anthropic returned an invalid model catalog page cursor.');
      }
      after = next;
    }
    const sorted = [...models.values()].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    return { models: sorted, baseUrl: normalizedBase, kind: preset.kind };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
