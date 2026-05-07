import { randomUUID } from 'node:crypto';
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
  const sanitizedResult = result == null
    ? null
    : Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'buffer'));

  return {
    ...jobWithoutResult,
    ...buildJoinClipsJobPaths(job.job_id),
    result: sanitizedResult,
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

async function readMultipartFormData(request, url, maxBodyBytes) {
  const bodyBuffer = await readBodyBuffer(request, maxBodyBytes);

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

  return formData;
}

async function readGenerateClipMultipartBody(request, url) {
  const formData = await readMultipartFormData(request, url, MAX_GENERATE_CLIP_BODY_BYTES);

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

  throw new Error('generate-clip only accepts multipart/form-data with binary file fields.');
}

function normalizeJoinClipBinaryFieldName(value, index) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`clips[${index}].clip_binary_field must be a non-empty string.`);
  }

  return value.trim();
}

async function readJoinClipsMultipartBody(request, url) {
  const formData = await readMultipartFormData(request, url, MAX_JOIN_CLIPS_BODY_BYTES);
  const clipsManifest = readFormJsonField(formData, 'clips', { required: true });

  if (!Array.isArray(clipsManifest) || clipsManifest.length === 0) {
    throw new Error('clips must contain a non-empty JSON array.');
  }

  const clips = await Promise.all(clipsManifest.map(async (clip, index) => {
    if (!clip || typeof clip !== 'object') {
      throw new Error(`clips[${index}] must be an object.`);
    }

    const clipPath = clip.clip_path ?? clip.path;
    const clipBinaryField = clip.clip_binary_field ?? clip.clipBinaryField;

    if (clipPath == null && clipBinaryField == null) {
      throw new Error(`clips[${index}] must include clip_path or clip_binary_field.`);
    }

    if (clipPath != null && clipBinaryField != null) {
      throw new Error(`clips[${index}] must not include both clip_path and clip_binary_field.`);
    }

    const normalizedClip = {
      transition_to_next: clip.transition_to_next,
    };

    if (clipPath != null) {
      if (typeof clipPath !== 'string' || clipPath.trim().length === 0) {
        throw new Error(`clips[${index}].clip_path must be a non-empty string.`);
      }

      normalizedClip.clip_path = clipPath.trim();
      return normalizedClip;
    }

    normalizedClip.clip_binary = await readFormBinaryField(
      formData,
      normalizeJoinClipBinaryFieldName(clipBinaryField, index),
      { required: true }
    );
    return normalizedClip;
  }));

  return {
    clips,
    width: readFormTextField(formData, 'width'),
    height: readFormTextField(formData, 'height'),
    fps: readFormTextField(formData, 'fps'),
    video_codec: readFormTextField(formData, 'video_codec'),
    encode_preset: readFormTextField(formData, 'encode_preset'),
    crf: readFormTextField(formData, 'crf'),
  };
}

async function readJoinClipsBody(request, url) {
  const contentType = getContentType(request);

  if (contentType.includes('multipart/form-data')) {
    return readJoinClipsMultipartBody(request, url);
  }

  throw new Error('join-clips only accepts multipart/form-data with binary file fields.');
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
          job: 'join_video_clips',
          ...buildJoinClipsJobPayload(job),
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/render/generate-clip') {
        const payload = await readGenerateClipBody(request, url);

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

      if (request.method === 'POST' && url.pathname === '/v1/compose/join-clips') {
        const payload = await readJoinClipsBody(request, url);

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
