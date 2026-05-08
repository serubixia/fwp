import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import Busboy from 'busboy';

import {
  cancelActiveJobProcesses,
  getHealthStatus,
  getPresetCatalog,
  generateClip,
  isProcessCancellationError,
  joinVideoClips,
  probeAudioDuration,
} from './ffmpeg-service.mjs';
import {
  getLogContext,
  logError,
  logInfo,
  logWarn,
  runWithLogContext,
} from './logger.mjs';
import {
  adjustManagedStorageUsageBytes,
  primeManagedStorageUsageBytes,
  reserveManagedStorageBytes,
  resolveManagedStorageMaxBytes,
  resolveManagedStorageRoot,
} from './storage-manager.mjs';

const PORT = Number(process.env.PORT || 3000);
const MAX_GENERATE_CLIP_BODY_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_JOIN_CLIPS_BODY_BYTES = 256 * 1024 * 1024;
const MAX_PROBE_AUDIO_BODY_BYTES = 64 * 1024 * 1024;
const DEFAULT_ASYNC_JOB_TTL_MS = 15 * 60 * 1000;
const DEFAULT_ASYNC_JOB_SWEEP_INTERVAL_MS = 60 * 1000;
const DEFAULT_ASYNC_JOB_MAX_CONCURRENCY = 1;
const DEFAULT_ASYNC_JOB_MAX_QUEUE = 8;
const DEFAULT_READINESS_CACHE_TTL_MS = 30 * 1000;
const DEFAULT_SHUTDOWN_GRACE_MS = 10 * 1000;
const DEFAULT_MULTIPART_STORAGE_SYNC_THRESHOLD_BYTES = 64 * 1024;
const ASYNC_JOB_RESULT_DIR_PREFIX = 'ffmpeg-api-job-result-';
const MULTIPART_UPLOAD_DIR_PREFIX = 'ffmpeg-api-upload-';
const GENERATE_CLIP_JOB_PATH_PATTERN = /^\/v1\/render\/jobs\/([^/]+?)(?:\/(download))?$/;
const JOIN_CLIPS_JOB_PATH_PATTERN = /^\/v1\/compose\/jobs\/([^/]+?)(?:\/(download))?$/;
const multipartPayloadCleanupHandlers = new WeakMap();

function resolvePositiveIntegerOption(value, optionName, fallback) {
  if (value == null || value === '') {
    return fallback;
  }

  const parsedValue = Number(value);
  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`${optionName} must be a positive integer.`);
  }

  return parsedValue;
}

function resolveNonNegativeIntegerOption(value, optionName, fallback) {
  if (value == null || value === '') {
    return fallback;
  }

  const parsedValue = Number(value);
  if (!Number.isInteger(parsedValue) || parsedValue < 0) {
    throw new Error(`${optionName} must be a non-negative integer.`);
  }

  return parsedValue;
}

function resolveShutdownGraceMs(value = process.env.SHUTDOWN_GRACE_MS) {
  return resolveNonNegativeIntegerOption(value, 'SHUTDOWN_GRACE_MS', DEFAULT_SHUTDOWN_GRACE_MS);
}

function resolveMultipartStorageSyncThresholdBytes(
  value = process.env.MULTIPART_STORAGE_SYNC_THRESHOLD_BYTES,
  optionName = 'multipartStorageSyncThresholdBytes'
) {
  return resolveNonNegativeIntegerOption(
    value,
    optionName,
    DEFAULT_MULTIPART_STORAGE_SYNC_THRESHOLD_BYTES
  );
}

function canWriteResponse(response) {
  return !response.destroyed && !response.writableEnded && !response.headersSent;
}

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

async function sendBinaryFile(response, statusCode, filePath, contentType, extraHeaders = {}) {
  const fileStats = await stat(filePath);

  response.writeHead(statusCode, {
    'content-type': contentType,
    'content-length': String(fileStats.size),
    ...extraHeaders,
  });

  await pipeline(createReadStream(filePath), response);
}

function getElapsedMilliseconds(startTime) {
  return Number((process.hrtime.bigint() - startTime) / 1000000n);
}

function summarizeBinaryField(upload) {
  if (!upload) {
    return null;
  }

  return {
    filename: upload.filename ?? upload.fileName,
    mime_type: upload.mime_type ?? upload.mimeType,
    size_bytes: upload.buffer?.length ?? upload.size_bytes ?? upload.file?.size,
  };
}

function sanitizeResult(result) {
  return result == null
    ? null
    : Object.fromEntries(Object.entries(result).filter(([key]) => !['buffer', 'file_path', 'temp_dir'].includes(key)));
}

function resolveAsyncJobStorageRoot(value) {
  return resolveManagedStorageRoot(value);
}

function resolveResultOwnedPath(value, label) {
  if (value == null) {
    return null;
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return path.resolve(value.trim());
}

function isPathInsideDirectory(targetPath, directoryPath) {
  const relativePath = path.relative(directoryPath, targetPath);

  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

async function persistJobResult(result, { jobId, jobType, storageRoot, storageMaxBytes }) {
  if (result == null) {
    return {
      result: null,
      file_path: null,
      temp_dir: null,
    };
  }

  const stagedFilePath = resolveResultOwnedPath(result.file_path, 'result.file_path');
  const stagedTempDir = resolveResultOwnedPath(result.temp_dir, 'result.temp_dir');

  if (stagedFilePath != null) {
    if (stagedTempDir != null && !isPathInsideDirectory(stagedFilePath, stagedTempDir)) {
      throw new Error('result.file_path must stay inside result.temp_dir.');
    }

    const sourceStats = await stat(stagedFilePath);
    if (!sourceStats.isFile()) {
      throw new Error('result.file_path must point to a file.');
    }

    if (stagedTempDir != null && isPathInsideDirectory(stagedTempDir, storageRoot)) {
      await adjustManagedStorageUsageBytes({
        storageRoot,
        deltaBytes: sourceStats.size,
      });

      return {
        result: sanitizeResult(result),
        file_path: stagedFilePath,
        temp_dir: stagedTempDir,
        size_bytes: sourceStats.size,
      };
    }

    const storageReservation = await reserveManagedStorageBytes({
      storageRoot,
      maxBytes: storageMaxBytes,
      bytes: sourceStats.size,
    });
    const tempDir = await mkdtemp(path.join(storageRoot, ASYNC_JOB_RESULT_DIR_PREFIX));
    const filename = path.basename(String(result.filename || path.basename(stagedFilePath) || `${jobType}-${jobId}.bin`));
    const filePath = path.join(tempDir, filename);

    try {
      await pipeline(createReadStream(stagedFilePath), createWriteStream(filePath));
      await adjustManagedStorageUsageBytes({
        storageRoot,
        deltaBytes: sourceStats.size,
      });
      if (stagedTempDir != null) {
        await rm(stagedTempDir, { recursive: true, force: true });
      }

      return {
        result: sanitizeResult(result),
        file_path: filePath,
        temp_dir: tempDir,
        size_bytes: sourceStats.size,
      };
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true });
      throw error;
    } finally {
      storageReservation.release();
    }
  }

  if (result.buffer == null) {
    return {
      result: sanitizeResult(result),
      file_path: null,
      temp_dir: null,
    };
  }

  const outputBuffer = Buffer.isBuffer(result.buffer) ? result.buffer : Buffer.from(result.buffer);
  const storageReservation = await reserveManagedStorageBytes({
    storageRoot,
    maxBytes: storageMaxBytes,
    bytes: outputBuffer.length,
  });
  const tempDir = await mkdtemp(path.join(storageRoot, ASYNC_JOB_RESULT_DIR_PREFIX));
  const filename = path.basename(String(result.filename || `${jobType}-${jobId}.bin`));
  const filePath = path.join(tempDir, filename);

  try {
    await writeFile(filePath, outputBuffer);
    await adjustManagedStorageUsageBytes({
      storageRoot,
      deltaBytes: outputBuffer.length,
    });

    return {
      result: sanitizeResult(result),
      file_path: filePath,
      temp_dir: tempDir,
      size_bytes: outputBuffer.length,
    };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  } finally {
    storageReservation.release();
  }
}

function setJobExpiry(job, ttlMs) {
  const expiresAtMilliseconds = Date.now() + ttlMs;

  job.expires_at = new Date(expiresAtMilliseconds).toISOString();
  job.expires_at_ms = expiresAtMilliseconds;
}

function createCachedReadinessProbe(healthStatusHandler, { cacheTtlMs = DEFAULT_READINESS_CACHE_TTL_MS } = {}) {
  let cachedStatus = null;
  let cachedError = null;
  let cacheExpiresAtMs = 0;
  let pendingStatusPromise = null;

  function clearCachedStatus() {
    cachedStatus = null;
    cachedError = null;
    cacheExpiresAtMs = 0;
  }

  function hasFreshCache(now = Date.now()) {
    return cacheTtlMs > 0 && cacheExpiresAtMs > now;
  }

  async function loadReadinessStatus() {
    if (!hasFreshCache()) {
      clearCachedStatus();
    }

    if (cachedStatus != null) {
      return cachedStatus;
    }

    if (cachedError != null) {
      throw cachedError;
    }

    if (pendingStatusPromise != null) {
      return pendingStatusPromise;
    }

    pendingStatusPromise = Promise.resolve()
      .then(() => healthStatusHandler())
      .then((status) => {
        if (cacheTtlMs > 0) {
          cachedStatus = status;
          cachedError = null;
          cacheExpiresAtMs = Date.now() + cacheTtlMs;
        }

        return status;
      })
      .catch((error) => {
        cachedError = error instanceof Error ? error : new Error(String(error));
        if (cacheTtlMs > 0) {
          cachedStatus = null;
          cacheExpiresAtMs = Date.now() + cacheTtlMs;
        }

        throw cachedError;
      })
      .finally(() => {
        pendingStatusPromise = null;
      });

    return pendingStatusPromise;
  }

  return {
    prime() {
      if (cacheTtlMs === 0) {
        return;
      }

      void loadReadinessStatus().catch(() => {});
    },
    async get() {
      return loadReadinessStatus();
    },
  };
}

function attachPayloadCleanup(payload, cleanup) {
  if (payload != null && typeof payload === 'object' && typeof cleanup === 'function') {
    multipartPayloadCleanupHandlers.set(payload, cleanup);
  }

  return payload;
}

function takePayloadCleanup(payload) {
  if (payload == null || typeof payload !== 'object') {
    return null;
  }

  const cleanup = multipartPayloadCleanupHandlers.get(payload) ?? null;
  multipartPayloadCleanupHandlers.delete(payload);
  return cleanup;
}

async function cleanupPayload(payload) {
  const cleanup = takePayloadCleanup(payload);
  if (cleanup != null) {
    await cleanup();
  }
}

function summarizeGenerateClipPayload(payload) {
  return {
    duration_seconds: payload.duration_seconds ?? payload.duration ?? undefined,
    width: payload.width,
    height: payload.height,
    fps: payload.fps,
    image_binary: summarizeBinaryField(payload.image_binary),
    voiceover_binary: summarizeBinaryField(payload.voiceover_binary),
    has_voiceover: payload.voiceover_binary != null,
    has_audio_text: typeof payload.audio_text === 'string',
    audio_text_length: payload.audio_text?.length,
    audio_language: payload.audio_language,
    overlay_text_length: payload.overlay_text?.length,
    scene_animation: payload.scene_animation == null
      ? undefined
      : {
        image_motion_preset: payload.scene_animation.image_motion_preset,
        text_motion_preset: payload.scene_animation.text_motion_preset,
        speed: payload.scene_animation.speed,
        text_anchor: payload.scene_animation.text_anchor,
      },
  };
}

function summarizeJoinClipsPayload(payload) {
  return {
    clip_count: Array.isArray(payload.clips) ? payload.clips.length : undefined,
    width: payload.width,
    height: payload.height,
    fps: payload.fps,
    clips: Array.isArray(payload.clips)
      ? payload.clips.map((clip) => ({
        clip_path: clip.clip_path,
        clip_binary: summarizeBinaryField(clip.clip_binary),
        transition_to_next: clip.transition_to_next == null
          ? undefined
          : {
            preset: clip.transition_to_next.preset,
            duration_seconds: clip.transition_to_next.duration_seconds,
          },
      }))
      : undefined,
  };
}

function summarizeProbeAudioPayload(payload) {
  return {
    audio_binary: summarizeBinaryField(payload.audio_binary),
  };
}

function getContentType(request) {
  return String(request.headers['content-type'] || '').toLowerCase();
}

function getDeclaredContentLength(request) {
  const headerValue = Array.isArray(request.headers['content-length'])
    ? request.headers['content-length'][0]
    : request.headers['content-length'];

  if (headerValue == null || String(headerValue).trim().length === 0) {
    return null;
  }

  const parsedValue = Number(headerValue);
  return Number.isInteger(parsedValue) && parsedValue >= 0 ? parsedValue : null;
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

function isJobFailureStatus(status) {
  return status === 'failed' || status === 'cancelled' || status === 'failed_shutdown';
}

function isJobTerminalStatus(status) {
  return status === 'completed' || isJobFailureStatus(status);
}

function buildGenerateClipJobPayload(job) {
  const {
    result,
    expires_at_ms,
    result_file_path,
    result_temp_dir,
    result_size_bytes,
    payload_cleanup,
    execution_promise,
    cancellation_status,
    cancellation_reason,
    cancelled_process_count,
    ...jobWithoutResult
  } = job;
  const sanitizedResult = result == null
    ? null
    : sanitizeResult(result);

  return {
    ...jobWithoutResult,
    ...buildGenerateClipJobPaths(job.job_id),
    result: sanitizedResult,
  };
}

function buildJoinClipsJobPayload(job) {
  const {
    result,
    expires_at_ms,
    result_file_path,
    result_temp_dir,
    result_size_bytes,
    payload_cleanup,
    execution_promise,
    cancellation_status,
    cancellation_reason,
    cancelled_process_count,
    ...jobWithoutResult
  } = job;
  const sanitizedResult = result == null
    ? null
    : sanitizeResult(result);

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

function createAsyncJobQueueFullError(schedulerState) {
  const error = new Error('Async job queue is full.');
  error.code = 'ASYNC_JOB_QUEUE_FULL';
  error.statusCode = 429;
  error.details = schedulerState == null
    ? undefined
    : {
      max_concurrent_jobs: schedulerState.max_concurrent_jobs,
      max_queued_jobs: schedulerState.max_queued_jobs,
      active_jobs: schedulerState.active_jobs,
      queued_jobs: schedulerState.queued_jobs,
    };
  return error;
}

function isAsyncJobQueueFullError(error) {
  return error?.code === 'ASYNC_JOB_QUEUE_FULL';
}

function ensureAsyncJobAdmission(jobStore) {
  const schedulerState = jobStore?.getSchedulerState?.();
  if (schedulerState == null) {
    return;
  }

  if (schedulerState.can_accept_job === false) {
    throw createAsyncJobQueueFullError(schedulerState);
  }
}

function createAsyncJobScheduler({
  maxConcurrentJobs = process.env.ASYNC_JOB_MAX_CONCURRENCY,
  maxQueuedJobs = process.env.ASYNC_JOB_MAX_QUEUE,
} = {}) {
  const effectiveMaxConcurrentJobs = resolvePositiveIntegerOption(
    maxConcurrentJobs,
    'asyncJobMaxConcurrency',
    DEFAULT_ASYNC_JOB_MAX_CONCURRENCY
  );
  const effectiveMaxQueuedJobs = resolveNonNegativeIntegerOption(
    maxQueuedJobs,
    'asyncJobMaxQueue',
    DEFAULT_ASYNC_JOB_MAX_QUEUE
  );
  const pendingTasks = [];
  let activeJobs = 0;
  let closed = false;

  function getState() {
    return {
      max_concurrent_jobs: effectiveMaxConcurrentJobs,
      max_queued_jobs: effectiveMaxQueuedJobs,
      active_jobs: activeJobs,
      queued_jobs: pendingTasks.length,
      can_accept_job: activeJobs < effectiveMaxConcurrentJobs || pendingTasks.length < effectiveMaxQueuedJobs,
    };
  }

  function drain() {
    if (closed) {
      return;
    }

    while (activeJobs < effectiveMaxConcurrentJobs && pendingTasks.length > 0) {
      const nextTask = pendingTasks.shift();
      if (nextTask == null) {
        return;
      }

      activeJobs += 1;
      queueMicrotask(() => {
        void Promise.resolve()
          .then(() => nextTask.run())
          .catch((error) => {
            logError('job.scheduler.failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(() => {
            activeJobs -= 1;
            drain();
          });
      });
    }
  }

  return {
    enqueue(taskId, task) {
      if (typeof taskId === 'function') {
        task = taskId;
        taskId = null;
      }

      if (typeof task !== 'function') {
        throw new Error('Async job scheduler task must be a function.');
      }

      if (closed) {
        throw new Error('Async job scheduler is closed.');
      }

      if (activeJobs >= effectiveMaxConcurrentJobs && pendingTasks.length >= effectiveMaxQueuedJobs) {
        throw createAsyncJobQueueFullError(getState());
      }

      pendingTasks.push({
        taskId,
        run: task,
      });
      drain();
    },
    cancel(taskId) {
      const pendingTaskIndex = pendingTasks.findIndex((pendingTask) => pendingTask.taskId === taskId);
      if (pendingTaskIndex === -1) {
        return false;
      }

      pendingTasks.splice(pendingTaskIndex, 1);
      return true;
    },
    getState,
    cleanup() {
      closed = true;
      pendingTasks.length = 0;
    },
  };
}

function createAsyncBinaryJobStore({
  jobType,
  handler,
  summarizePayload,
  jobTtlMs = process.env.ASYNC_JOB_TTL_MS,
  jobSweepIntervalMs = process.env.ASYNC_JOB_SWEEP_INTERVAL_MS,
  storageRoot = process.env.ASYNC_JOB_STORAGE_ROOT,
  storageMaxBytes = process.env.FFMPEG_STORAGE_MAX_BYTES,
  scheduler,
  maxConcurrentJobs = process.env.ASYNC_JOB_MAX_CONCURRENCY,
  maxQueuedJobs = process.env.ASYNC_JOB_MAX_QUEUE,
} = {}) {
  const jobs = new Map();
  const effectiveJobTtlMs = resolvePositiveIntegerOption(
    jobTtlMs,
    `${jobType}.jobTtlMs`,
    DEFAULT_ASYNC_JOB_TTL_MS
  );
  const effectiveJobSweepIntervalMs = resolvePositiveIntegerOption(
    jobSweepIntervalMs,
    `${jobType}.jobSweepIntervalMs`,
    DEFAULT_ASYNC_JOB_SWEEP_INTERVAL_MS
  );
  const effectiveStorageRoot = resolveAsyncJobStorageRoot(storageRoot);
  const effectiveStorageMaxBytes = resolveManagedStorageMaxBytes(storageMaxBytes);
  const effectiveScheduler = scheduler ?? createAsyncJobScheduler({
    maxConcurrentJobs,
    maxQueuedJobs,
  });
  const ownsScheduler = scheduler == null;

  async function cleanupJobArtifacts(job) {
    if (job?.result_temp_dir != null) {
      await rm(job.result_temp_dir, { recursive: true, force: true });

      if (job.result_size_bytes != null && job.result_size_bytes > 0) {
        await adjustManagedStorageUsageBytes({
          storageRoot: effectiveStorageRoot,
          deltaBytes: -job.result_size_bytes,
        });
      }
    }

    if (job) {
      job.result_temp_dir = null;
      job.result_file_path = null;
      job.result_size_bytes = null;
    }
  }

  async function cleanupJobPayload(job) {
    if (typeof job?.payload_cleanup !== 'function') {
      return;
    }

    const payloadCleanup = job.payload_cleanup;
    job.payload_cleanup = null;

    try {
      await payloadCleanup();
    } catch (error) {
      logError('job.payload.cleanup.failed', {
        job_id: job.job_id,
        job_type: jobType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function deleteJob(jobId) {
    const job = jobs.get(jobId);
    if (!job) {
      return null;
    }

    jobs.delete(jobId);
    await Promise.allSettled([
      cleanupJobArtifacts(job),
      cleanupJobPayload(job),
    ]);
    return job;
  }

  async function expireJobIfNeeded(jobId, now = Date.now()) {
    const job = jobs.get(jobId);
    if (!job) {
      return null;
    }

    if (job.expires_at_ms != null && job.expires_at_ms <= now) {
      await deleteJob(jobId);
      return null;
    }

    return job;
  }

  async function sweepExpiredJobs() {
    const now = Date.now();
    await Promise.allSettled([...jobs.keys()].map((jobId) => expireJobIfNeeded(jobId, now)));
  }

  const sweepTimer = setInterval(() => {
    void sweepExpiredJobs();
  }, effectiveJobSweepIntervalMs);
  sweepTimer.unref?.();

  async function finalizeCancelledJob(job, { durationMs } = {}) {
    if (job.completed_at != null) {
      return job;
    }

    job.result = null;
    await cleanupJobArtifacts(job);
    await cleanupJobPayload(job);
    job.status = job.cancellation_status ?? 'cancelled';
    job.error = job.cancellation_reason ?? job.error ?? 'Job cancelled.';
    job.completed_at = new Date().toISOString();
    setJobExpiry(job, effectiveJobTtlMs);

    logWarn('job.cancelled', {
      job_id: job.job_id,
      job_type: jobType,
      duration_ms: durationMs,
      status: job.status,
      error: job.error,
      cancelled_process_count: job.cancelled_process_count > 0 ? job.cancelled_process_count : undefined,
    });

    return job;
  }

  async function processJob(job, payload, logContext) {
    await runWithLogContext(logContext, async () => {
      if (job.cancellation_status != null) {
        await finalizeCancelledJob(job);
        return;
      }

      job.status = 'running';
      job.started_at = new Date().toISOString();
      const startedAt = process.hrtime.bigint();

      logInfo('job.started', {
        job_id: job.job_id,
        job_type: jobType,
      });

      try {
        await primeManagedStorageUsageBytes(effectiveStorageRoot);
        const rawResult = await handler(payload);
        if (job.cancellation_status != null) {
          throw new Error(job.cancellation_reason ?? 'Job cancelled.');
        }

        const persistedResult = await persistJobResult(rawResult, {
          jobId: job.job_id,
          jobType,
          storageRoot: effectiveStorageRoot,
          storageMaxBytes: effectiveStorageMaxBytes,
        });

        job.result = persistedResult.result;
        job.result_file_path = persistedResult.file_path;
        job.result_temp_dir = persistedResult.temp_dir;
        job.result_size_bytes = persistedResult.size_bytes ?? null;
        if (job.cancellation_status != null) {
          throw new Error(job.cancellation_reason ?? 'Job cancelled.');
        }

        job.status = 'completed';
        job.error = null;
        logInfo('job.completed', {
          job_id: job.job_id,
          job_type: jobType,
          duration_ms: getElapsedMilliseconds(startedAt),
          result: job.result,
        });
      } catch (error) {
        job.result = null;
        await cleanupJobArtifacts(job);
        const errorMessage = error instanceof Error ? error.message : String(error);

        if (job.cancellation_status != null || isProcessCancellationError(error)) {
          job.status = job.cancellation_status ?? 'cancelled';
          job.error = job.cancellation_reason ?? errorMessage;
          logWarn('job.cancelled', {
            job_id: job.job_id,
            job_type: jobType,
            duration_ms: getElapsedMilliseconds(startedAt),
            status: job.status,
            error: job.error,
            cancelled_process_count: job.cancelled_process_count > 0 ? job.cancelled_process_count : undefined,
          });
        } else {
          job.status = 'failed';
          job.error = errorMessage;
          logError('job.failed', {
            job_id: job.job_id,
            job_type: jobType,
            duration_ms: getElapsedMilliseconds(startedAt),
            error: job.error,
          });
        }
      } finally {
        await cleanupJobPayload(job);
        job.completed_at = new Date().toISOString();
        setJobExpiry(job, effectiveJobTtlMs);
      }
    });
  }

  return {
    enqueue(payload) {
      const payloadCleanup = takePayloadCleanup(payload);
      const job = {
        job_id: randomUUID(),
        status: 'queued',
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
        expires_at: null,
        expires_at_ms: null,
        error: null,
        result: null,
        result_file_path: null,
        result_temp_dir: null,
        result_size_bytes: null,
        payload_cleanup: payloadCleanup,
        execution_promise: null,
        cancellation_status: null,
        cancellation_reason: null,
        cancelled_process_count: 0,
      };

      jobs.set(job.job_id, job);
      const inheritedLogContext = getLogContext();
      try {
        effectiveScheduler.enqueue(job.job_id, () => {
          const executionPromise = processJob(job, payload, {
            ...inheritedLogContext,
            job_id: job.job_id,
            job_type: jobType,
          });
          job.execution_promise = executionPromise;
          return executionPromise;
        });
      } catch (error) {
        jobs.delete(job.job_id);
        if (payloadCleanup != null) {
          attachPayloadCleanup(payload, payloadCleanup);
        }

        throw error;
      }

      const schedulerState = effectiveScheduler.getState();
      logInfo('job.queued', {
        job_id: job.job_id,
        job_type: jobType,
        payload: summarizePayload(payload),
        max_concurrent_jobs: schedulerState.max_concurrent_jobs,
        active_jobs: schedulerState.active_jobs,
        queued_jobs: schedulerState.queued_jobs,
      });

      return job;
    },
    async get(jobId) {
      return expireJobIfNeeded(jobId);
    },
    async cancel(jobId, { reason = 'Job cancelled by client request.' } = {}) {
      const job = await expireJobIfNeeded(jobId);
      if (!job) {
        return null;
      }

      if (isJobTerminalStatus(job.status)) {
        return {
          accepted: false,
          immediate: false,
          job,
        };
      }

      const cancellationAlreadyRequested = job.cancellation_status != null;
      if (!cancellationAlreadyRequested) {
        job.cancellation_status = 'cancelled';
        job.cancellation_reason = reason;
        job.error = reason;
      }

      if (job.status === 'queued' && effectiveScheduler.cancel(job.job_id)) {
        await finalizeCancelledJob(job);
        return {
          accepted: true,
          immediate: true,
          job,
        };
      }

      job.status = 'cancelling';
      if (!cancellationAlreadyRequested) {
        job.cancelled_process_count = cancelActiveJobProcesses(job.job_id, job.cancellation_reason);
        logWarn('job.cancel.requested', {
          job_id: job.job_id,
          job_type: jobType,
          status: job.status,
          reason: job.cancellation_reason,
        });
      }

      return {
        accepted: true,
        immediate: false,
        job,
      };
    },
    getSchedulerState() {
      return effectiveScheduler.getState();
    },
    async cleanup() {
      clearInterval(sweepTimer);
      if (ownsScheduler) {
        effectiveScheduler.cleanup();
      }

      const jobSnapshots = [...jobs.values()];
      jobs.clear();

      for (const job of jobSnapshots) {
        if (job.status === 'queued') {
          job.status = 'cancelled';
          job.error = 'Job cancelled during server shutdown.';
          job.completed_at = new Date().toISOString();
          setJobExpiry(job, effectiveJobTtlMs);
          logWarn('job.cancelled', {
            job_id: job.job_id,
            job_type: jobType,
            status: job.status,
            error: job.error,
          });
          continue;
        }

        if (job.completed_at == null && (job.status === 'running' || job.execution_promise != null)) {
          job.cancellation_status = 'failed_shutdown';
          job.cancellation_reason = 'Job aborted during server shutdown.';
          job.cancelled_process_count = cancelActiveJobProcesses(job.job_id, job.cancellation_reason);
        }
      }

      await Promise.allSettled(
        jobSnapshots
          .filter((job) => job.execution_promise != null && job.completed_at == null)
          .map((job) => job.execution_promise)
      );

      await Promise.allSettled(jobSnapshots.flatMap((job) => [
        cleanupJobArtifacts(job),
        cleanupJobPayload(job),
      ]));
    },
  };
}

function createGenerateClipJobStore({ generateClipHandler = generateClip, ...options } = {}) {
  return createAsyncBinaryJobStore({
    ...options,
    jobType: 'generate_clip',
    handler: generateClipHandler,
    summarizePayload: summarizeGenerateClipPayload,
  });
}

function createJoinClipsJobStore({ joinVideoClipsHandler = joinVideoClips, ...options } = {}) {
  return createAsyncBinaryJobStore({
    ...options,
    jobType: 'join_video_clips',
    handler: joinVideoClipsHandler,
    summarizePayload: summarizeJoinClipsPayload,
  });
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

  if (typeof value.file_path === 'string') {
    const sizeBytes = Number(value.size_bytes ?? 0);

    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      throw new Error(`${fieldName} must not be empty.`);
    }

    return {
      file_path: value.file_path,
      filename: value.filename || undefined,
      mime_type: value.mime_type || undefined,
      size_bytes: sizeBytes,
    };
  }

  if (Number(value.size) <= 0) {
    throw new Error(`${fieldName} must not be empty.`);
  }

  return {
    file: value,
    filename: value.name || undefined,
    mime_type: value.type || undefined,
    size_bytes: Number(value.size) || undefined,
  };
}

function sanitizeMultipartPathSegment(value, fallback) {
  const normalizedValue = String(value || '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return normalizedValue.length > 0 ? normalizedValue : fallback;
}

function buildMultipartFileEntry(filePath, info, sizeBytes) {
  return {
    file_path: filePath,
    filename: info.filename || undefined,
    mime_type: info.mimeType || undefined,
    size_bytes: sizeBytes,
  };
}

async function readMultipartFormData(request, url, maxBodyBytes, {
  storageRoot = process.env.ASYNC_JOB_STORAGE_ROOT,
  storageMaxBytes = process.env.FFMPEG_STORAGE_MAX_BYTES,
  multipartStorageSyncThresholdBytes = process.env.MULTIPART_STORAGE_SYNC_THRESHOLD_BYTES,
} = {}) {
  void url;

  const declaredContentLength = getDeclaredContentLength(request);
  if (declaredContentLength != null && declaredContentLength > maxBodyBytes) {
    throw new Error(`Request body exceeds the ${maxBodyBytes} byte limit.`);
  }

  const effectiveStorageRoot = resolveAsyncJobStorageRoot(storageRoot);
  const effectiveStorageMaxBytes = resolveManagedStorageMaxBytes(storageMaxBytes);
  const effectiveMultipartStorageSyncThresholdBytes = resolveMultipartStorageSyncThresholdBytes(
    multipartStorageSyncThresholdBytes,
    'multipartStorageSyncThresholdBytes'
  );
  const storageReservation = declaredContentLength == null
    ? null
    : await reserveManagedStorageBytes({
      storageRoot: effectiveStorageRoot,
      maxBytes: effectiveStorageMaxBytes,
      bytes: declaredContentLength,
    });
  const tempDir = await mkdtemp(path.join(effectiveStorageRoot, MULTIPART_UPLOAD_DIR_PREFIX));
  const dynamicStorageReservation = declaredContentLength == null
    ? await reserveManagedStorageBytes({
      storageRoot: effectiveStorageRoot,
      maxBytes: effectiveStorageMaxBytes,
      bytes: 0,
    })
    : null;
  const textFields = new Map();
  const fileFields = new Map();
  const fileWritePromises = new Set();
  let busboy;

  try {
    busboy = Busboy({ headers: request.headers });
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    dynamicStorageReservation?.release();
    storageReservation?.release();
    throw new Error(`Invalid multipart/form-data body: ${error.message}`);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let totalBytes = 0;
    let fileIndex = 0;
    let observedMultipartFileBytes = 0;
    let persistedMultipartFileBytes = 0;
    const activeFileWriters = new Set();
    const dynamicStorageBaselineUsageBytes = dynamicStorageReservation?.usageBytes ?? 0;
    let dynamicStorageSyncRequested = false;
    let dynamicStorageSyncInFlight = false;
    let dynamicStorageSyncPromise = Promise.resolve();
    let lastSyncedAccountedMultipartBytes = 0;
    let lastSyncedPersistedMultipartFileBytes = 0;

    function refreshWriterProgress(writerState) {
      const writtenBytes = writerState.writeStream.bytesWritten;
      if (writtenBytes <= writerState.lastBytesWritten) {
        return;
      }

      persistedMultipartFileBytes += writtenBytes - writerState.lastBytesWritten;
      writerState.lastBytesWritten = writtenBytes;
    }

    function refreshAllWriterProgress() {
      for (const writerState of activeFileWriters) {
        refreshWriterProgress(writerState);
      }
    }

    function getPendingMultipartBytes() {
      return Math.max(0, observedMultipartFileBytes - persistedMultipartFileBytes);
    }

    function getAccountedMultipartBytes() {
      return persistedMultipartFileBytes + getPendingMultipartBytes();
    }

    function shouldSyncChunkStorageCapacity({ force = false } = {}) {
      if (force) {
        return true;
      }

      const accountedMultipartBytes = getAccountedMultipartBytes();
      if (accountedMultipartBytes < lastSyncedAccountedMultipartBytes) {
        return true;
      }

      if (effectiveMultipartStorageSyncThresholdBytes === 0) {
        return accountedMultipartBytes !== lastSyncedAccountedMultipartBytes;
      }

      return accountedMultipartBytes - lastSyncedAccountedMultipartBytes >= effectiveMultipartStorageSyncThresholdBytes;
    }

    function syncChunkStorageCapacity({ force = false } = {}) {
      if (dynamicStorageReservation == null) {
        return Promise.resolve();
      }

      if (!shouldSyncChunkStorageCapacity({ force })) {
        return dynamicStorageSyncPromise;
      }

      dynamicStorageSyncRequested = true;
      if (dynamicStorageSyncInFlight) {
        return dynamicStorageSyncPromise;
      }

      dynamicStorageSyncPromise = (async () => {
        dynamicStorageSyncInFlight = true;

        try {
          while (dynamicStorageSyncRequested) {
            dynamicStorageSyncRequested = false;
            refreshAllWriterProgress();

            await dynamicStorageReservation.setBytes(getPendingMultipartBytes(), {
              usageBytes: dynamicStorageBaselineUsageBytes + persistedMultipartFileBytes,
            });
            lastSyncedAccountedMultipartBytes = getAccountedMultipartBytes();
            lastSyncedPersistedMultipartFileBytes = persistedMultipartFileBytes;
          }
        } catch (error) {
          rejectOnce(error);
          throw error;
        } finally {
          dynamicStorageSyncInFlight = false;
        }
      })();
      void dynamicStorageSyncPromise.catch(() => {});
      return dynamicStorageSyncPromise;
    }

    async function cleanupTempDir() {
      await Promise.allSettled([...fileWritePromises]);
      await Promise.allSettled([dynamicStorageSyncPromise]);
      await rm(tempDir, { recursive: true, force: true });

      if (dynamicStorageReservation != null && lastSyncedPersistedMultipartFileBytes > 0) {
        await adjustManagedStorageUsageBytes({
          storageRoot: effectiveStorageRoot,
          deltaBytes: -lastSyncedPersistedMultipartFileBytes,
        });
      }

      dynamicStorageReservation?.release();
      storageReservation?.release();
    }

    function teardownRequest() {
      request.off('data', onData);
      request.off('error', onRequestError);
      request.off('aborted', onRequestAborted);
    }

    function teardownBusboy() {
      busboy.off('error', onBusboyError);
      busboy.off('finish', onBusboyFinish);
    }

    function rejectOnce(error) {
      if (settled) {
        return;
      }

      settled = true;
      teardownRequest();
      request.unpipe(busboy);
      busboy.destroy();
      request.resume();
      void cleanupTempDir().finally(() => {
        reject(error);
      });
    }

    function onData(chunk) {
      totalBytes += chunk.length;
      if (totalBytes > maxBodyBytes) {
        rejectOnce(new Error(`Request body exceeds the ${maxBodyBytes} byte limit.`));
        return;
      }
    }

    function onRequestError(error) {
      rejectOnce(error);
    }

    function onRequestAborted() {
      rejectOnce(new Error('Request was aborted.'));
    }

    function onBusboyError(error) {
      rejectOnce(new Error(`Invalid multipart/form-data body: ${error.message}`));
    }

    function onBusboyFinish() {
      if (settled) {
        return;
      }

      void Promise.all([...fileWritePromises])
        .then(() => syncChunkStorageCapacity({ force: true }))
        .then(() => dynamicStorageSyncPromise)
        .then(() => {
          if (settled) {
            return;
          }

          settled = true;
          teardownRequest();
          teardownBusboy();
          resolve({
            get(fieldName) {
              if (fileFields.has(fieldName)) {
                return fileFields.get(fieldName);
              }

              if (textFields.has(fieldName)) {
                return textFields.get(fieldName);
              }

              return null;
            },
            cleanup: cleanupTempDir,
          });
        })
        .catch((error) => {
          rejectOnce(new Error(`Invalid multipart/form-data body: ${error.message}`));
        });
    }

    busboy.on('field', (fieldName, value) => {
      if (!textFields.has(fieldName)) {
        textFields.set(fieldName, value);
      }
    });

    busboy.on('file', (fieldName, fileStream, info) => {
      fileIndex += 1;
      const originalFilename = path.basename(info.filename || '');
      const extension = path.extname(originalFilename).toLowerCase();
      const baseName = extension.length > 0
        ? originalFilename.slice(0, -extension.length)
        : originalFilename;
      const filePath = path.join(
        tempDir,
        `${String(fileIndex).padStart(2, '0')}-${sanitizeMultipartPathSegment(fieldName, 'field')}-${sanitizeMultipartPathSegment(baseName, 'upload')}${extension}`
      );
      const writeStream = createWriteStream(filePath);
      const writerState = {
        writeStream,
        lastBytesWritten: 0,
      };
      let sizeBytes = 0;

      activeFileWriters.add(writerState);

      fileStream.on('data', (chunk) => {
        sizeBytes += chunk.length;
        observedMultipartFileBytes += chunk.length;
        void syncChunkStorageCapacity();
      });

      fileStream.on('error', (error) => {
        rejectOnce(new Error(`Invalid multipart/form-data body: ${error.message}`));
      });

      const writePromise = pipeline(fileStream, writeStream)
        .then(async () => {
          refreshWriterProgress(writerState);
          activeFileWriters.delete(writerState);

          if (fileFields.has(fieldName)) {
            await rm(filePath, { force: true });
            persistedMultipartFileBytes = Math.max(0, persistedMultipartFileBytes - sizeBytes);
            void syncChunkStorageCapacity();
            return;
          }

          fileFields.set(fieldName, buildMultipartFileEntry(filePath, info, sizeBytes));
        });

      fileWritePromises.add(writePromise);
      writePromise
        .catch((error) => {
          rejectOnce(new Error(`Invalid multipart/form-data body: ${error.message}`));
        })
        .finally(() => {
          refreshWriterProgress(writerState);
          activeFileWriters.delete(writerState);
          fileWritePromises.delete(writePromise);
          void syncChunkStorageCapacity();
        });
    });

    request.on('data', onData);
    request.on('error', onRequestError);
    request.on('aborted', onRequestAborted);
    busboy.on('error', onBusboyError);
    busboy.on('finish', onBusboyFinish);
    request.pipe(busboy);
  });
}

async function readGenerateClipMultipartBody(request, url, storageOptions) {
  const formData = await readMultipartFormData(request, url, MAX_GENERATE_CLIP_BODY_BYTES, storageOptions);

  try {
    const payload = {
      overlay_text: readFormTextField(formData, 'overlay_text', { required: true }),
      audio_text: readFormTextField(formData, 'audio_text'),
      audio_language: readFormTextField(formData, 'audio_language'),
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

    return attachPayloadCleanup(payload, formData.cleanup);
  } catch (error) {
    await formData.cleanup();
    throw error;
  }
}

async function readGenerateClipBody(request, url, storageOptions) {
  const contentType = getContentType(request);

  if (contentType.includes('multipart/form-data')) {
    return readGenerateClipMultipartBody(request, url, storageOptions);
  }

  throw new Error('generate-clip only accepts multipart/form-data with binary file fields.');
}

async function readProbeAudioMultipartBody(request, url, storageOptions) {
  const formData = await readMultipartFormData(request, url, MAX_PROBE_AUDIO_BODY_BYTES, storageOptions);

  try {
    return attachPayloadCleanup({
      audio_binary: await readFormBinaryField(formData, 'audio_binary', { required: true }),
    }, formData.cleanup);
  } catch (error) {
    await formData.cleanup();
    throw error;
  }
}

async function readProbeAudioBody(request, url, storageOptions) {
  const contentType = getContentType(request);

  if (contentType.includes('multipart/form-data')) {
    return readProbeAudioMultipartBody(request, url, storageOptions);
  }

  throw new Error('probe-duration only accepts multipart/form-data with binary file fields.');
}

function normalizeJoinClipBinaryFieldName(value, index) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`clips[${index}].clip_binary_field must be a non-empty string.`);
  }

  return value.trim();
}

async function readJoinClipsMultipartBody(request, url, maxBodyBytes = DEFAULT_MAX_JOIN_CLIPS_BODY_BYTES, storageOptions) {
  const formData = await readMultipartFormData(request, url, maxBodyBytes, storageOptions);

  try {
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

    return attachPayloadCleanup({
      clips,
      width: readFormTextField(formData, 'width'),
      height: readFormTextField(formData, 'height'),
      fps: readFormTextField(formData, 'fps'),
      video_codec: readFormTextField(formData, 'video_codec'),
      encode_preset: readFormTextField(formData, 'encode_preset'),
      crf: readFormTextField(formData, 'crf'),
    }, formData.cleanup);
  } catch (error) {
    await formData.cleanup();
    throw error;
  }
}

async function readJoinClipsBody(request, url, maxBodyBytes = DEFAULT_MAX_JOIN_CLIPS_BODY_BYTES, storageOptions) {
  const contentType = getContentType(request);

  if (contentType.includes('multipart/form-data')) {
    return readJoinClipsMultipartBody(request, url, maxBodyBytes, storageOptions);
  }

  throw new Error('join-clips only accepts multipart/form-data with binary file fields.');
}

export function createServer({
  generateClipHandler = generateClip,
  joinVideoClipsHandler = joinVideoClips,
  probeAudioDurationHandler = probeAudioDuration,
  healthStatusHandler = getHealthStatus,
  presetCatalogHandler = getPresetCatalog,
  generateClipJobStore,
  joinClipsJobStore,
  maxJoinClipsBodyBytes = process.env.MAX_JOIN_CLIPS_BODY_BYTES,
  asyncJobTtlMs = process.env.ASYNC_JOB_TTL_MS,
  asyncJobSweepIntervalMs = process.env.ASYNC_JOB_SWEEP_INTERVAL_MS,
  asyncJobStorageRoot = process.env.ASYNC_JOB_STORAGE_ROOT,
  storageMaxBytes = process.env.FFMPEG_STORAGE_MAX_BYTES,
  asyncJobMaxConcurrency = process.env.ASYNC_JOB_MAX_CONCURRENCY,
  asyncJobMaxQueue = process.env.ASYNC_JOB_MAX_QUEUE,
  readinessCacheTtlMs = process.env.READINESS_CACHE_TTL_MS,
  multipartStorageSyncThresholdBytes = process.env.MULTIPART_STORAGE_SYNC_THRESHOLD_BYTES,
} = {}) {
  const effectiveMaxJoinClipsBodyBytes = resolvePositiveIntegerOption(
    maxJoinClipsBodyBytes,
    'maxJoinClipsBodyBytes',
    DEFAULT_MAX_JOIN_CLIPS_BODY_BYTES
  );
  const sharedAsyncJobScheduler = generateClipJobStore == null || joinClipsJobStore == null
    ? createAsyncJobScheduler({
      maxConcurrentJobs: asyncJobMaxConcurrency,
      maxQueuedJobs: asyncJobMaxQueue,
    })
    : null;
  const effectiveGenerateClipJobStore = generateClipJobStore ?? createGenerateClipJobStore({
    generateClipHandler,
    jobTtlMs: asyncJobTtlMs,
    jobSweepIntervalMs: asyncJobSweepIntervalMs,
    storageRoot: asyncJobStorageRoot,
    storageMaxBytes,
    scheduler: sharedAsyncJobScheduler ?? undefined,
  });
  const effectiveJoinClipsJobStore = joinClipsJobStore ?? createJoinClipsJobStore({
    joinVideoClipsHandler,
    jobTtlMs: asyncJobTtlMs,
    jobSweepIntervalMs: asyncJobSweepIntervalMs,
    storageRoot: asyncJobStorageRoot,
    storageMaxBytes,
    scheduler: sharedAsyncJobScheduler ?? undefined,
  });
  const effectiveReadinessCacheTtlMs = resolveNonNegativeIntegerOption(
    readinessCacheTtlMs,
    'readinessCacheTtlMs',
    DEFAULT_READINESS_CACHE_TTL_MS
  );
  const readinessProbe = createCachedReadinessProbe(healthStatusHandler, {
    cacheTtlMs: effectiveReadinessCacheTtlMs,
  });
  readinessProbe.prime();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    const requestContext = {
      request_id: randomUUID(),
      http_method: request.method || 'GET',
      http_path: url.pathname,
    };
    const startedAt = process.hrtime.bigint();

    response.on('finish', () => {
      void runWithLogContext(requestContext, async () => {
        logInfo('http.request.completed', {
          status_code: response.statusCode,
          duration_ms: getElapsedMilliseconds(startedAt),
          response_content_type: String(response.getHeader('content-type') || ''),
        });
      });
    });

    request.on('aborted', () => {
      void runWithLogContext(requestContext, async () => {
        logError('http.request.aborted', {
          duration_ms: getElapsedMilliseconds(startedAt),
        });
      });
    });

    void runWithLogContext(requestContext, async () => {
      logInfo('http.request.started', {
        content_type: getContentType(request) || undefined,
        content_length: request.headers['content-length'],
      });

      try {
        if (request.method === 'GET' && url.pathname === '/health') {
          sendJson(response, 200, {
            ok: true,
            status: 'live',
          });
          return;
        }

        if (request.method === 'GET' && (url.pathname === '/readyz' || url.pathname === '/healthz')) {
          try {
            sendJson(response, 200, await readinessProbe.get());
          } catch (error) {
            logError('health.readiness.failed', {
              error: error.message,
            });
            sendJson(response, 503, {
              ok: false,
              error: error.message,
            });
          }
          return;
        }

        if (request.method === 'GET' && url.pathname === '/v1/presets') {
          sendJson(response, 200, presetCatalogHandler());
          return;
        }

        if (request.method === 'POST' && url.pathname === '/v1/audio/probe-duration') {
          const payload = await readProbeAudioBody(request, url, {
            storageRoot: asyncJobStorageRoot,
            storageMaxBytes,
            multipartStorageSyncThresholdBytes,
          });
          logInfo('http.request.parsed', {
            operation: 'probe_duration',
            payload: summarizeProbeAudioPayload(payload),
          });

          let payloadCleaned = false;
          try {
            const probeResult = await probeAudioDurationHandler(payload);
            await cleanupPayload(payload);
            payloadCleaned = true;

            sendJson(response, 200, {
              ok: true,
              ...probeResult,
            });
          } finally {
            if (!payloadCleaned) {
              await cleanupPayload(payload);
            }
          }
          return;
        }

        const jobMatch = matchGenerateClipJobPath(url.pathname);
        if (request.method === 'GET' && jobMatch) {
          const job = await effectiveGenerateClipJobStore.get(jobMatch.jobId);
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
                error: isJobFailureStatus(job.status)
                  ? job.error || 'Render job failed.'
                  : 'Render job is not completed yet.',
                ...buildGenerateClipJobPayload(job),
              });
              return;
            }

            if (job.result_file_path == null) {
              sendJson(response, 410, {
                ok: false,
                error: 'Render job output is no longer available.',
                ...buildGenerateClipJobPayload(job),
              });
              return;
            }

            await sendBinaryFile(
              response,
              200,
              job.result_file_path,
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

        if (request.method === 'DELETE' && jobMatch && jobMatch.action === 'status') {
          const cancellation = await effectiveGenerateClipJobStore.cancel(jobMatch.jobId);
          if (!cancellation) {
            sendJson(response, 404, {
              ok: false,
              error: `Render job ${jobMatch.jobId} was not found.`,
            });
            return;
          }

          const jobPayload = buildGenerateClipJobPayload(cancellation.job);
          if (!cancellation.accepted) {
            sendJson(response, 409, {
              ok: false,
              error: `Render job ${jobMatch.jobId} cannot be cancelled from status ${cancellation.job.status}.`,
              job: 'generate_clip',
              ...jobPayload,
            });
            return;
          }

          sendJson(response, 202, {
            ok: true,
            cancellation_requested: true,
            job: 'generate_clip',
            ...jobPayload,
          }, {
            location: jobPayload.status_path,
          });
          return;
        }

        const joinClipsJobMatch = matchJoinClipsJobPath(url.pathname);
        if (request.method === 'GET' && joinClipsJobMatch) {
          const job = await effectiveJoinClipsJobStore.get(joinClipsJobMatch.jobId);
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
                error: isJobFailureStatus(job.status)
                  ? job.error || 'Compose job failed.'
                  : 'Compose job is not completed yet.',
                ...buildJoinClipsJobPayload(job),
              });
              return;
            }

            if (job.result_file_path == null) {
              sendJson(response, 410, {
                ok: false,
                error: 'Compose job output is no longer available.',
                ...buildJoinClipsJobPayload(job),
              });
              return;
            }

            await sendBinaryFile(
              response,
              200,
              job.result_file_path,
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

        if (request.method === 'DELETE' && joinClipsJobMatch && joinClipsJobMatch.action === 'status') {
          const cancellation = await effectiveJoinClipsJobStore.cancel(joinClipsJobMatch.jobId);
          if (!cancellation) {
            sendJson(response, 404, {
              ok: false,
              error: `Compose job ${joinClipsJobMatch.jobId} was not found.`,
            });
            return;
          }

          const jobPayload = buildJoinClipsJobPayload(cancellation.job);
          if (!cancellation.accepted) {
            sendJson(response, 409, {
              ok: false,
              error: `Compose job ${joinClipsJobMatch.jobId} cannot be cancelled from status ${cancellation.job.status}.`,
              job: 'join_video_clips',
              ...jobPayload,
            });
            return;
          }

          sendJson(response, 202, {
            ok: true,
            cancellation_requested: true,
            job: 'join_video_clips',
            ...jobPayload,
          }, {
            location: jobPayload.status_path,
          });
          return;
        }

        if (request.method === 'POST' && url.pathname === '/v1/render/generate-clip') {
          ensureAsyncJobAdmission(effectiveGenerateClipJobStore);
          const payload = await readGenerateClipBody(request, url, {
            storageRoot: asyncJobStorageRoot,
            storageMaxBytes,
            multipartStorageSyncThresholdBytes,
          });
          logInfo('http.request.parsed', {
            operation: 'generate_clip',
            payload: summarizeGenerateClipPayload(payload),
          });

          let job;
          try {
            job = effectiveGenerateClipJobStore.enqueue(payload);
          } catch (error) {
            await cleanupPayload(payload);
            throw error;
          }
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
          ensureAsyncJobAdmission(effectiveJoinClipsJobStore);
          const payload = await readJoinClipsBody(request, url, effectiveMaxJoinClipsBodyBytes, {
            storageRoot: asyncJobStorageRoot,
            storageMaxBytes,
            multipartStorageSyncThresholdBytes,
          });
          logInfo('http.request.parsed', {
            operation: 'join_clips',
            payload: summarizeJoinClipsPayload(payload),
          });

          let job;
          try {
            job = effectiveJoinClipsJobStore.enqueue(payload);
          } catch (error) {
            await cleanupPayload(payload);
            throw error;
          }
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
            'GET /readyz',
            'GET /healthz',
            'GET /v1/presets',
            'POST /v1/audio/probe-duration',
            'POST /v1/render/generate-clip',
            'GET /v1/render/jobs/<job_id>',
            'DELETE /v1/render/jobs/<job_id>',
            'GET /v1/render/jobs/<job_id>/download',
            'POST /v1/compose/join-clips',
            'GET /v1/compose/jobs/<job_id>',
            'DELETE /v1/compose/jobs/<job_id>',
            'GET /v1/compose/jobs/<job_id>/download',
          ],
        });
      } catch (error) {
        logError('http.request.failed', {
          error: error.message,
        });

        if (!canWriteResponse(response)) {
          return;
        }

        try {
          sendJson(response, error.statusCode ?? (isAsyncJobQueueFullError(error) ? 429 : 400), {
            ok: false,
            error: error.message,
            ...(error.details ?? null),
          });
        } catch (responseError) {
          logWarn('http.response.write_failed', {
            error: responseError.message,
          });
        }
      }
    });
  });

  server.on('close', () => {
    sharedAsyncJobScheduler?.cleanup();
    void Promise.allSettled([
      effectiveGenerateClipJobStore.cleanup?.(),
      effectiveJoinClipsJobStore.cleanup?.(),
    ]);
  });

  return server;
}

const modulePath = fileURLToPath(import.meta.url);

function closeHttpServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function closeIdleHttpConnections(server) {
  server.closeIdleConnections?.();
}

function closeAllHttpConnections(server) {
  closeIdleHttpConnections(server);
  server.closeAllConnections?.();
}

function installSignalHandlers(server, { shutdownGraceMs = process.env.SHUTDOWN_GRACE_MS } = {}) {
  let shutdownRequested = false;
  const effectiveShutdownGraceMs = resolveShutdownGraceMs(shutdownGraceMs);

  async function handleSignal(signal) {
    if (shutdownRequested) {
      return;
    }

    shutdownRequested = true;
    logInfo('server.shutdown.requested', {
      signal,
      shutdown_grace_ms: effectiveShutdownGraceMs,
    });

    closeIdleHttpConnections(server);

    const shutdownDeadlineTimer = setTimeout(() => {
      logWarn('server.shutdown.deadline_exceeded', {
        signal,
        shutdown_grace_ms: effectiveShutdownGraceMs,
      });
      closeAllHttpConnections(server);
    }, effectiveShutdownGraceMs);
    shutdownDeadlineTimer.unref?.();

    try {
      await closeHttpServer(server);
      clearTimeout(shutdownDeadlineTimer);
      logInfo('server.shutdown.completed', {
        signal,
        shutdown_grace_ms: effectiveShutdownGraceMs,
      });
    } catch (error) {
      clearTimeout(shutdownDeadlineTimer);
      process.exitCode = 1;
      logError('server.shutdown.failed', {
        signal,
        error: error.message,
      });
    }
  }

  process.on('SIGTERM', () => {
    void handleSignal('SIGTERM');
  });
  process.on('SIGINT', () => {
    void handleSignal('SIGINT');
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  const server = createServer();
  installSignalHandlers(server);
  server.listen(PORT, () => {
    logInfo('server.started', {
      port: PORT,
      bind: '0.0.0.0',
    });
  });
}
