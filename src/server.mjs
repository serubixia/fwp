import http from 'node:http';

import {
  getHealthStatus,
  getPresetCatalog,
  generateClip,
  joinVideoClips,
} from './ffmpeg-service.mjs';

const PORT = Number(process.env.PORT || 3000);
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const MAX_GENERATE_CLIP_BODY_BYTES = 64 * 1024 * 1024;

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function sendBinary(response, statusCode, body, contentType, extraHeaders = {}) {
  response.writeHead(statusCode, {
    'content-type': contentType,
    'content-length': String(body.length),
    ...extraHeaders,
  });
  response.end(body);
}

function getContentType(request) {
  return String(request.headers['content-type'] || '').toLowerCase();
}

function readBodyBuffer(request, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;

    request.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBodyBytes) {
        reject(new Error(`Request body exceeds the ${maxBodyBytes} byte limit.`));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });

    request.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    request.on('error', reject);
  });
}

async function readJsonBody(request, maxBodyBytes = MAX_JSON_BODY_BYTES) {
  const bodyBuffer = await readBodyBuffer(request, maxBodyBytes);
  const body = bodyBuffer.toString('utf8');

  if (!body.trim()) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`Invalid JSON body: ${error.message}`);
  }
}

function readFormTextField(formData, fieldName, { required = false } = {}) {
  const value = formData.get(fieldName);

  if (value == null) {
    if (required) {
      throw new Error(`${fieldName} is required in multipart/form-data.`);
    }

    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be sent as a text field.`);
  }

  const trimmedValue = value.trim();
  if (required && trimmedValue.length === 0) {
    throw new Error(`${fieldName} must not be empty.`);
  }

  return trimmedValue.length > 0 ? trimmedValue : undefined;
}

function readFormJsonField(formData, fieldName, { required = false } = {}) {
  const rawValue = readFormTextField(formData, fieldName, { required });
  if (rawValue == null) {
    return undefined;
  }

  try {
    return JSON.parse(rawValue);
  } catch (error) {
    throw new Error(`${fieldName} must contain valid JSON: ${error.message}`);
  }
}

async function readFormBinaryField(formData, fieldName, { required = false } = {}) {
  const value = formData.get(fieldName);

  if (value == null) {
    if (required) {
      throw new Error(`${fieldName} is required in multipart/form-data.`);
    }

    return undefined;
  }

  if (typeof value === 'string') {
    throw new Error(`${fieldName} must be sent as a binary file field.`);
  }

  const buffer = Buffer.from(await value.arrayBuffer());
  if (buffer.length === 0) {
    throw new Error(`${fieldName} must not be empty.`);
  }

  return {
    buffer,
    filename: value.name || undefined,
    mime_type: value.type || undefined,
  };
}

async function readGenerateClipMultipartBody(request, url) {
  const bodyBuffer = await readBodyBuffer(request, MAX_GENERATE_CLIP_BODY_BYTES);

  let formData;
  try {
    const webRequest = new Request(url.toString(), {
      method: request.method || 'POST',
      headers: request.headers,
      body: bodyBuffer,
    });

    formData = await webRequest.formData();
  } catch (error) {
    throw new Error(`Invalid multipart/form-data body: ${error.message}`);
  }

  const payload = {
    overlay_text: readFormTextField(formData, 'overlay_text', { required: true }),
    duration_seconds: readFormTextField(formData, 'duration_seconds', { required: true }),
    width: readFormTextField(formData, 'width'),
    height: readFormTextField(formData, 'height'),
    fps: readFormTextField(formData, 'fps'),
    font_size: readFormTextField(formData, 'font_size'),
    font_color: readFormTextField(formData, 'font_color'),
    border_color: readFormTextField(formData, 'border_color'),
    font_file: readFormTextField(formData, 'font_file'),
    video_codec: readFormTextField(formData, 'video_codec'),
    encode_preset: readFormTextField(formData, 'encode_preset'),
    crf: readFormTextField(formData, 'crf'),
    audio_codec: readFormTextField(formData, 'audio_codec'),
    audio_bitrate: readFormTextField(formData, 'audio_bitrate'),
    audio_sample_rate: readFormTextField(formData, 'audio_sample_rate'),
    scene_animation: readFormJsonField(formData, 'scene_animation', { required: true }),
    voiceover_mix: readFormJsonField(formData, 'voiceover_mix'),
    image_binary: await readFormBinaryField(formData, 'image_binary', { required: true }),
  };

  const voiceoverBinary = await readFormBinaryField(formData, 'voiceover_binary');
  if (voiceoverBinary) {
    payload.voiceover_binary = voiceoverBinary;
  }

  return payload;
}

async function readGenerateClipBody(request, url) {
  const contentType = getContentType(request);

  if (contentType.includes('multipart/form-data')) {
    return readGenerateClipMultipartBody(request, url);
  }

  if (contentType.includes('application/json') || contentType.length === 0) {
    return readJsonBody(request, MAX_GENERATE_CLIP_BODY_BYTES);
  }

  throw new Error('generate-clip only accepts application/json or multipart/form-data.');
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

  try {
    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, await getHealthStatus());
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/presets') {
      sendJson(response, 200, getPresetCatalog());
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/render/generate-clip') {
      const payload = await readGenerateClipBody(request, url);
      const result = await generateClip(payload);
      sendBinary(
        response,
        200,
        result.buffer,
        result.content_type,
        {
          'content-disposition': `inline; filename="${result.filename}"`,
        }
      );
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/compose/join-clips') {
      const payload = await readJsonBody(request);
      sendJson(response, 200, {
        ok: true,
        job: 'join_video_clips',
        result: await joinVideoClips(payload),
      });
      return;
    }

    sendJson(response, 404, {
      ok: false,
      error: 'Not found.',
      available_routes: [
        'GET /health',
        'GET /v1/presets',
        'POST /v1/render/generate-clip',
        'POST /v1/compose/join-clips',
      ],
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error.message,
    });
  }
});

server.listen(PORT, () => {
  console.log(`ffmpeg-api listening on http://0.0.0.0:${PORT}`);
});
