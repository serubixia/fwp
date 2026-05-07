import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getHealthStatus,
  getPresetCatalog,
  generateClip,
  joinVideoClips,
} from './ffmpeg-service.mjs';

const PORT = Number(process.env.PORT || 3000);
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const MAX_GENERATE_CLIP_BODY_BYTES = 64 * 1024 * 1024;
const MAX_JOIN_CLIPS_BODY_BYTES = 64 * 1024 * 1024;
const GENERATE_CLIP_JOB_PATH_PATTERN = /^\/v1\/render\/jobs\/([^/]+?)(?:\/(download))?$/;
const JOIN_CLIPS_JOB_PATH_PATTERN = /^\/v1\/compose\/jobs\/([^/]+?)(?:\/(download))?$/;

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    ...extraHeaders,
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

function normalizeBooleanFlag(value, label) {
  if (value == null) {
    return false;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  if (typeof value === 'string') {
    const normalizedValue = value.trim().toLowerCase();
    if (normalizedValue.length === 0) {
      return false;
    }

    if (['1', 'true', 'yes', 'on'].includes(normalizedValue)) {
      return true;
    }

    if (['0', 'false', 'no', 'off'].includes(normalizedValue)) {
      return false;
    }
  }

  throw new Error(`${label} must be a boolean.`);
}

function buildGenerateClipJobPaths(jobId) {
  const encodedJobId = encodeURIComponent(jobId);
  const statusPath = `/v1/render/jobs/${encodedJobId}`;

  return {
    status_path: statusPath,
    download_path: `${statusPath}/download`,
  };
}

function buildJoinClipsJobPaths(jobId) {
  const encodedJobId = encodeURIComponent(jobId);
  const statusPath = `/v1/compose/jobs/${encodedJobId}`;

  return {
    status_path: statusPath,
    download_path: `${statusPath}/download`,
  };
}

function buildGenerateClipJobPayload(job) {
  const { result, ...jobWithoutResult } = job;
  const sanitizedResult = result == null
    ? null
    : Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'buffer'));

  return {
    ...jobWithoutResult,
    ...buildGenerateClipJobPaths(job.job_id),
    result: sanitizedResult,
  };
}

function buildJoinClipsJobPayload(job) {
  const { result, ...jobWithoutResult } = job;

  return {
    ...jobWithoutResult,
    ...buildJoinClipsJobPaths(job.job_id),
    result,
  };
}

function matchGenerateClipJobPath(pathname) {
  const match = pathname.match(GENERATE_CLIP_JOB_PATH_PATTERN);
  if (!match) {
    return null;
  }

  return {
    jobId: decodeURIComponent(match[1]),
    action: match[2] === 'download' ? 'download' : 'status',
  };
}

function matchJoinClipsJobPath(pathname) {
  const match = pathname.match(JOIN_CLIPS_JOB_PATH_PATTERN);
  if (!match) {
    return null;
  }

  return {
    jobId: decodeURIComponent(match[1]),
    action: match[2] === 'download' ? 'download' : 'status',
  };
}

function wantsAsyncGenerateClip(url, payload) {
  if (url.searchParams.has('async')) {
    return normalizeBooleanFlag(url.searchParams.get('async'), 'async');
  }

  return normalizeBooleanFlag(payload?.async ?? payload?.async_job ?? payload?.asyncJob, 'async');
}

export function createGenerateClipJobStore({ generateClipHandler = generateClip } = {}) {
  const jobs = new Map();

  async function processJob(job, payload) {
    job.status = 'running';
    job.started_at = new Date().toISOString();

    try {
      job.result = await generateClipHandler(payload);
      job.status = 'completed';
      job.error = null;
    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
      job.result = null;
    } finally {
      job.completed_at = new Date().toISOString();
    }
  }

  return {
    enqueue(payload) {
      const job = {
        job_id: randomUUID(),
        status: 'queued',
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
        error: null,
        result: null,
      };

      jobs.set(job.job_id, job);
      queueMicrotask(() => {
        void processJob(job, payload);
      });

      return job;
    },
    get(jobId) {
      return jobs.get(jobId) ?? null;
    },
  };
}

export function createJoinClipsJobStore({ joinVideoClipsHandler = joinVideoClips } = {}) {
  const jobs = new Map();

  async function processJob(job, payload) {
    job.status = 'running';
    job.started_at = new Date().toISOString();

    try {
      job.result = await joinVideoClipsHandler(payload);
      job.status = 'completed';
      job.error = null;
    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
      job.result = null;
    } finally {
      job.completed_at = new Date().toISOString();
    }
  }

  return {
    enqueue(payload) {
      const job = {
        job_id: randomUUID(),
        status: 'queued',
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
        error: null,
        result: null,
      };

      jobs.set(job.job_id, job);
      queueMicrotask(() => {
        void processJob(job, payload);
      });

      return job;
    },
    get(jobId) {
      return jobs.get(jobId) ?? null;
    },
  };
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
async function readGenerateClipBody(request) {
  const contentType = getContentType(request);

  if (contentType.includes('application/json') || contentType.length === 0) {
    return readJsonBody(request, MAX_GENERATE_CLIP_BODY_BYTES);
  }

  throw new Error('generate-clip only accepts application/json.');
}

export function createServer({
  generateClipHandler = generateClip,
  joinVideoClipsHandler = joinVideoClips,
  healthStatusHandler = getHealthStatus,
  presetCatalogHandler = getPresetCatalog,
  generateClipJobStore,
  joinClipsJobStore,
} = {}) {
  const effectiveGenerateClipJobStore = generateClipJobStore ?? createGenerateClipJobStore({
    generateClipHandler,
  });
  const effectiveJoinClipsJobStore = joinClipsJobStore ?? createJoinClipsJobStore({
    joinVideoClipsHandler,
  });

  return http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, await healthStatusHandler());
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v1/presets') {
        sendJson(response, 200, presetCatalogHandler());
        return;
      }

      const jobMatch = matchGenerateClipJobPath(url.pathname);
      if (request.method === 'GET' && jobMatch) {
        const job = effectiveGenerateClipJobStore.get(jobMatch.jobId);
        if (!job) {
          sendJson(response, 404, {
            ok: false,
            error: `Render job ${jobMatch.jobId} was not found.`,
          });
          return;
        }

        if (jobMatch.action === 'download') {
          if (job.status !== 'completed' || job.result == null) {
            sendJson(response, 409, {
              ok: false,
              error: job.status === 'failed'
                ? job.error || 'Render job failed.'
                : 'Render job is not completed yet.',
              ...buildGenerateClipJobPayload(job),
            });
            return;
          }

          sendBinary(
            response,
            200,
            job.result.buffer,
            job.result.content_type,
            {
              'content-disposition': `inline; filename="${job.result.filename}"`,
            }
          );
          return;
        }

        sendJson(response, 200, {
          ok: true,
          job: 'generate_clip',
          ...buildGenerateClipJobPayload(job),
        });
        return;
      }

      const joinClipsJobMatch = matchJoinClipsJobPath(url.pathname);
      if (request.method === 'GET' && joinClipsJobMatch) {
        const job = effectiveJoinClipsJobStore.get(joinClipsJobMatch.jobId);
        if (!job) {
          sendJson(response, 404, {
            ok: false,
            error: `Compose job ${joinClipsJobMatch.jobId} was not found.`,
          });
          return;
        }

        if (joinClipsJobMatch.action === 'download') {
          if (job.status !== 'completed' || job.result == null) {
            sendJson(response, 409, {
              ok: false,
              error: job.status === 'failed'
                ? job.error || 'Compose job failed.'
                : 'Compose job is not completed yet.',
              ...buildJoinClipsJobPayload(job),
            });
            return;
          }

          const outputBuffer = await readFile(job.result.output_path);
          sendBinary(
            response,
            200,
            outputBuffer,
            'video/mp4',
            {
              'content-disposition': `inline; filename="${path.basename(job.result.output_path)}"`,
            }
          );
          return;
        }

        sendJson(response, 200, {
          ok: true,
          job: 'join_video_clips',
          ...buildJoinClipsJobPayload(job),
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/render/generate-clip') {
        const payload = await readGenerateClipBody(request);

        if (wantsAsyncGenerateClip(url, payload)) {
          const job = effectiveGenerateClipJobStore.enqueue(payload);
          const jobPayload = buildGenerateClipJobPayload(job);

          sendJson(response, 202, {
            ok: true,
            async: true,
            job: 'generate_clip',
            ...jobPayload,
          }, {
            location: jobPayload.status_path,
          });
          return;
        }

        const result = await generateClipHandler(payload);
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
        const payload = await readJsonBody(request, MAX_JOIN_CLIPS_BODY_BYTES);

        if (wantsAsyncGenerateClip(url, payload)) {
          const job = effectiveJoinClipsJobStore.enqueue(payload);
          const jobPayload = buildJoinClipsJobPayload(job);

          sendJson(response, 202, {
            ok: true,
            async: true,
            job: 'join_video_clips',
            ...jobPayload,
          }, {
            location: jobPayload.status_path,
          });
          return;
        }

        sendJson(response, 200, {
          ok: true,
          job: 'join_video_clips',
          result: await joinVideoClipsHandler(payload),
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
          'GET /v1/render/jobs/<job_id>',
          'GET /v1/render/jobs/<job_id>/download',
          'POST /v1/compose/join-clips',
          'GET /v1/compose/jobs/<job_id>',
          'GET /v1/compose/jobs/<job_id>/download',
        ],
      });
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        error: error.message,
      });
    }
  });
}

const modulePath = fileURLToPath(import.meta.url);

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  const server = createServer();
  server.listen(PORT, () => {
    console.log(`ffmpeg-api listening on http://0.0.0.0:${PORT}`);
  });
}
