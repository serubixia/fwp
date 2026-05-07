import http from 'node:http';

import {
  getHealthStatus,
  getPresetCatalog,
  generateClip,
  joinVideoClips,
} from './ffmpeg-service.mjs';

const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_BYTES = 1024 * 1024;

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';

    request.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(new Error('Request body exceeds the 1 MB limit.'));
        request.destroy();
      }
    });

    request.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });

    request.on('error', reject);
  });
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
      const payload = await readJsonBody(request);
      sendJson(response, 200, {
        ok: true,
        job: 'generate_clip',
        result: await generateClip(payload),
      });
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
  console.log(`docker-ffmpeg listening on http://0.0.0.0:${PORT}`);
});
