import { spawn } from 'node:child_process';
import { createWriteStream, readdirSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { getLogContext, logError, logInfo, logWarn } from './logger.mjs';
import {
  reserveManagedStorageBytes,
  resolveManagedStorageMaxBytes,
  resolveManagedStorageRoot,
} from './storage-manager.mjs';

const SCENE_IMAGE_MOTION_PRESETS = Object.freeze([
  'static_hold',
  'slow_push_in',
  'slow_pull_out',
  'pan_left_slow',
  'pan_right_slow',
  'drift_up_soft',
  'drift_down_soft',
  'parallax_float',
]);

const SCENE_TEXT_MOTION_PRESETS = Object.freeze([
  'fade_in_hold',
  'fade_up_soft',
  'slide_left_soft',
  'slide_right_soft',
  'type_on_soft',
]);

const SCENE_ANIMATION_SPEEDS = Object.freeze(['slow', 'medium']);
const SCENE_TEXT_ANCHORS = Object.freeze(['upper_third', 'center', 'lower_third']);
const SCENE_TRANSITION_PRESETS = Object.freeze([
  'none',
  'fade',
  'wipe_left',
  'wipe_right',
  'wipe_up',
  'wipe_down',
  'slide_left',
  'slide_right',
  'zoom_in',
]);

const XFADE_TRANSITIONS = Object.freeze({
  fade: 'fade',
  wipe_left: 'wipeleft',
  wipe_right: 'wiperight',
  wipe_up: 'wipeup',
  wipe_down: 'wipedown',
  slide_left: 'slideleft',
  slide_right: 'slideright',
  zoom_in: 'zoomin',
});

const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const DEFAULT_FPS = 30;
const DEFAULT_CRF = 18;
const DEFAULT_VIDEO_CODEC = 'libx264';
const DEFAULT_ENCODE_PRESET = 'medium';
const LONG_RENDER_ENCODE_PRESET = 'veryfast';
const LONG_RENDER_THRESHOLD_SECONDS = 20;
const DEFAULT_AUDIO_CODEC = 'aac';
const DEFAULT_AUDIO_BITRATE = '192k';
const DEFAULT_AUDIO_SAMPLE_RATE = 48000;
const DEFAULT_BACKGROUND_MUSIC_VOLUME = 0.08;
const DEFAULT_BACKGROUND_MUSIC_FADE_IN_SECONDS = 0.2;
const DEFAULT_BACKGROUND_MUSIC_FADE_OUT_SECONDS = 0.35;
const DEFAULT_BACKGROUND_MUSIC_LOOP = true;
const DEFAULT_BACKGROUND_MUSIC_DUCKING_ENABLED = true;
const DEFAULT_BACKGROUND_MUSIC_DUCKING_THRESHOLD = 0.015;
const DEFAULT_BACKGROUND_MUSIC_DUCKING_RATIO = 10;
const DEFAULT_BACKGROUND_MUSIC_DUCKING_ATTACK_MS = 20;
const DEFAULT_BACKGROUND_MUSIC_DUCKING_RELEASE_MS = 250;
const BACKGROUND_MUSIC_COLLECTIONS = Object.freeze(['long-form', 'shorts']);
const BACKGROUND_MUSIC_EXTENSIONS = Object.freeze(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']);
const DEFAULT_BACKGROUND_MUSIC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'audio');
const LEGACY_BACKGROUND_MUSIC_ID_FORMAT = '<channel_slug>/<long-form|shorts>/<filename>';
const DEFAULT_FONT_SIZE = 72;
const DEFAULT_FONT_COLOR = 'white';
const DEFAULT_BORDER_COLOR = 'black@0.45';
const DEFAULT_SUBTITLE_LANGUAGE = 'es';
const DEFAULT_SUBTITLE_DEVICE = 'cpu';
const DEFAULT_SUBTITLE_THEME = 'default';
const DEFAULT_SUBTITLE_DELIVERY = 'burned';
const SUBTITLE_DELIVERY_OPTIONS = Object.freeze(['burned', 'external']);
const SUBTITLE_LAYOUT_BASE_WIDTH = 1920;
const SUBTITLE_LAYOUT_BASE_HEIGHT = 1080;
const LIBASS_DEFAULT_PLAYRES_X = 384;
const LIBASS_DEFAULT_PLAYRES_Y = 288;
const DEFAULT_SUBTITLE_OUTLINE = 2;
const SRT_CONTENT_TYPE = 'application/x-subrip';
const SUBTITLE_THEME_PROFILES = Object.freeze({
  default: Object.freeze({
    font_name: 'DejaVu Sans',
    font_size: 30,
    base_colour: '&H00FFFFFF',
    highlight_colour: '&H004AD5FF',
    outline_colour: '&H00101010',
    back_colour: '&H64000000',
    alignment: 2,
    margin_l: 80,
    margin_r: 80,
    margin_v: 64,
    bold: -1,
    uppercase: false,
  }),
  lime: Object.freeze({
    font_name: 'DejaVu Sans',
    font_size: 32,
    base_colour: '&H00FFFFFF',
    highlight_colour: '&H0056FF6A',
    outline_colour: '&H00101010',
    back_colour: '&H64000000',
    alignment: 2,
    margin_l: 76,
    margin_r: 76,
    margin_v: 60,
    bold: -1,
    uppercase: false,
  }),
  top: Object.freeze({
    font_name: 'DejaVu Sans',
    font_size: 28,
    base_colour: '&H00FFFFFF',
    highlight_colour: '&H00759CFF',
    outline_colour: '&H00101010',
    back_colour: '&H64000000',
    alignment: 8,
    margin_l: 84,
    margin_r: 84,
    margin_v: 72,
    bold: -1,
    uppercase: false,
  }),
  caps: Object.freeze({
    font_name: 'DejaVu Sans',
    font_size: 34,
    base_colour: '&H00FFFFFF',
    highlight_colour: '&H0000D7FF',
    outline_colour: '&H00101010',
    back_colour: '&H64000000',
    alignment: 2,
    margin_l: 72,
    margin_r: 72,
    margin_v: 58,
    bold: -1,
    uppercase: true,
  }),
});
const GENERATE_CLIP_UPLOAD_DIR_PREFIX = 'ffmpeg-api-generate-clip-';
const JOIN_CLIPS_UPLOAD_DIR_PREFIX = 'ffmpeg-api-join-clips-';
const PROBE_AUDIO_UPLOAD_DIR_PREFIX = 'ffmpeg-api-probe-audio-';
const ACTIVE_JOB_PROCESS_KILL_GRACE_MS = 1000;
const DEFAULT_FFMPEG_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_FFPROBE_COMMAND_TIMEOUT_MS = 30 * 1000;
const WHISPERX_ALIGN_SCRIPT_PATH = fileURLToPath(new URL('./whisperx-align.py', import.meta.url));
const WAV_MIME_TYPES = Object.freeze(['audio/wav', 'audio/x-wav']);
const MIME_TYPE_EXTENSIONS = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/ogg': '.ogg',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-matroska': '.mkv',
});
const activeJobProcesses = new Map();

function formatNumber(value, digits = 6) {
  return Number(value.toFixed(digits)).toString();
}

function normalizePositiveInteger(value, fallback, label) {
  const numericValue = value == null ? fallback : Number(value);
  if (!Number.isInteger(numericValue) || numericValue <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return numericValue;
}

function normalizePositiveNumber(value, fallback, label) {
  const numericValue = value == null ? fallback : Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return numericValue;
}

function normalizeNonNegativeNumber(value, fallback, label) {
  const numericValue = value == null ? fallback : Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    throw new Error(`${label} must be a non-negative number.`);
  }
  return numericValue;
}

function normalizeOptionalString(value, fallback) {
  if (value == null) {
    return fallback;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Expected a non-empty string.');
  }
  return value.trim();
}

function normalizeNullableString(value, label) {
  if (value == null) {
    return null;
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return value.trim();
}

function normalizeOptionalBoolean(value, fallback, label) {
  if (value == null) {
    return fallback;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalizedValue = value.trim().toLowerCase();

    if (['true', '1', 'yes', 'on'].includes(normalizedValue)) {
      return true;
    }

    if (['false', '0', 'no', 'off'].includes(normalizedValue)) {
      return false;
    }
  }

  throw new Error(`${label} must be a boolean.`);
}

function ensureEnum(value, allowedValues, label) {
  if (!allowedValues.includes(value)) {
    throw new Error(`${label} must be one of: ${allowedValues.join(', ')}.`);
  }
  return value;
}

function ensureNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function escapeDrawtextText(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%')
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\n/g, '\\\n');
}

function escapeFilterLiteral(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:');
}

function escapeFilterOptionValue(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,');
}

function escapeExpression(value) {
  return String(value).replace(/,/g, '\\,');
}

function createProcessCancellationError(binary, reason, signal) {
  const error = new Error(reason == null
    ? `${binary} was cancelled.`
    : `${binary} was cancelled: ${reason}`);

  error.name = 'ProcessCancelledError';
  error.code = 'PROCESS_CANCELLED';
  error.cancel_reason = reason ?? null;
  error.signal = signal ?? null;
  return error;
}

export function isProcessCancellationError(error) {
  return error?.code === 'PROCESS_CANCELLED';
}

function createProcessTimeoutError(binary, timeoutMs, signal) {
  const error = new Error(`${binary} timed out after ${timeoutMs}ms.`);

  error.name = 'ProcessTimeoutError';
  error.code = 'PROCESS_TIMEOUT';
  error.timeout_ms = timeoutMs;
  error.signal = signal ?? null;
  return error;
}

export function isProcessTimeoutError(error) {
  return error?.code === 'PROCESS_TIMEOUT';
}

function resolveCommandTimeoutMs(binary, timeoutMs) {
  if (timeoutMs != null) {
    return normalizeNonNegativeNumber(timeoutMs, 0, `${binary} timeout_ms`);
  }

  const binaryName = path.basename(binary);
  if (binaryName === 'ffmpeg') {
    return normalizeNonNegativeNumber(
      process.env.FFMPEG_COMMAND_TIMEOUT_MS,
      DEFAULT_FFMPEG_COMMAND_TIMEOUT_MS,
      'FFMPEG_COMMAND_TIMEOUT_MS'
    );
  }

  if (binaryName === 'ffprobe') {
    return normalizeNonNegativeNumber(
      process.env.FFPROBE_COMMAND_TIMEOUT_MS,
      DEFAULT_FFPROBE_COMMAND_TIMEOUT_MS,
      'FFPROBE_COMMAND_TIMEOUT_MS'
    );
  }

  return 0;
}

function getActiveJobProcessSet(jobId) {
  const existingSet = activeJobProcesses.get(jobId);
  if (existingSet != null) {
    return existingSet;
  }

  const processSet = new Set();
  activeJobProcesses.set(jobId, processSet);
  return processSet;
}

function registerActiveJobProcess(jobId, processInfo) {
  if (typeof jobId !== 'string' || jobId.trim().length === 0) {
    return;
  }

  getActiveJobProcessSet(jobId).add(processInfo);
}

function unregisterActiveJobProcess(jobId, processInfo) {
  if (typeof jobId !== 'string' || jobId.trim().length === 0) {
    return;
  }

  const processSet = activeJobProcesses.get(jobId);
  if (processSet == null) {
    return;
  }

  processSet.delete(processInfo);
  if (processSet.size === 0) {
    activeJobProcesses.delete(jobId);
  }
}

function clearProcessKillTimer(processInfo) {
  if (processInfo.kill_timer != null) {
    clearTimeout(processInfo.kill_timer);
    processInfo.kill_timer = null;
  }
}

function clearProcessTimeoutTimer(processInfo) {
  if (processInfo.timeout_timer != null) {
    clearTimeout(processInfo.timeout_timer);
    processInfo.timeout_timer = null;
  }
}

function requestProcessTermination(processInfo, {
  kind,
  reason,
  timeoutMs = null,
  eventName,
} = {}) {
  if (
    processInfo == null
    || processInfo.exited
    || processInfo.cancel_requested
    || processInfo.timeout_requested
  ) {
    return false;
  }

  processInfo.cancel_requested = kind === 'cancel';
  processInfo.cancel_reason = kind === 'cancel' ? reason : null;
  processInfo.timeout_requested = kind === 'timeout';
  processInfo.timeout_ms = kind === 'timeout' ? timeoutMs : null;
  clearProcessTimeoutTimer(processInfo);

  let signalAccepted = false;
  try {
    signalAccepted = processInfo.child.kill('SIGTERM');
  } catch (error) {
    processInfo.cancel_requested = false;
    processInfo.cancel_reason = null;
    processInfo.timeout_requested = false;
    processInfo.timeout_ms = null;
    logError('process.command.cancel_request_failed', {
      binary: processInfo.binary,
      job_id: processInfo.job_id,
      error: error.message,
    });
    return false;
  }

  if (!signalAccepted) {
    processInfo.cancel_requested = false;
    processInfo.cancel_reason = null;
    processInfo.timeout_requested = false;
    processInfo.timeout_ms = null;
    return false;
  }

  logWarn(eventName, {
    binary: processInfo.binary,
    job_id: processInfo.job_id,
    reason: kind === 'cancel' ? reason : undefined,
    timeout_ms: kind === 'timeout' ? timeoutMs : undefined,
  });

  processInfo.kill_timer = setTimeout(() => {
    if (processInfo.exited) {
      return;
    }

    try {
      processInfo.child.kill('SIGKILL');
    } catch {
      return;
    }
  }, ACTIVE_JOB_PROCESS_KILL_GRACE_MS);
  processInfo.kill_timer.unref?.();
  return true;
}

function requestProcessCancellation(processInfo, reason) {
  return requestProcessTermination(processInfo, {
    kind: 'cancel',
    reason,
    eventName: 'process.command.cancel_requested',
  });
}

function requestProcessTimeout(processInfo, timeoutMs) {
  return requestProcessTermination(processInfo, {
    kind: 'timeout',
    timeoutMs,
    eventName: 'process.command.timeout_requested',
  });
}

export function cancelActiveJobProcesses(jobId, reason = 'Job cancelled.') {
  if (typeof jobId !== 'string' || jobId.trim().length === 0) {
    return 0;
  }

  const processSet = activeJobProcesses.get(jobId);
  if (processSet == null || processSet.size === 0) {
    return 0;
  }

  let cancelledCount = 0;
  for (const processInfo of processSet) {
    if (requestProcessCancellation(processInfo, reason)) {
      cancelledCount += 1;
    }
  }

  return cancelledCount;
}

export async function runCommand(binary, args, { timeoutMs } = {}) {
  const startedAt = Date.now();
  const commandPreview = `${binary} ${args.join(' ')}`;
  const logContext = getLogContext();
  const jobId = typeof logContext.job_id === 'string' ? logContext.job_id : null;
  const effectiveTimeoutMs = resolveCommandTimeoutMs(binary, timeoutMs);

  logInfo('process.command.started', {
    binary,
    command: commandPreview.length > 1200 ? `${commandPreview.slice(0, 1197)}...` : commandPreview,
    timeout_ms: effectiveTimeoutMs > 0 ? effectiveTimeoutMs : undefined,
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const processInfo = {
      binary,
      child,
      job_id: jobId,
      cancel_requested: false,
      cancel_reason: null,
      timeout_requested: false,
      timeout_ms: null,
      exited: false,
      kill_timer: null,
      timeout_timer: null,
    };

    registerActiveJobProcess(jobId, processInfo);

    let stdout = '';
    let stderr = '';

    function finalize() {
      if (processInfo.exited) {
        return;
      }

      processInfo.exited = true;
      clearProcessKillTimer(processInfo);
      clearProcessTimeoutTimer(processInfo);
      unregisterActiveJobProcess(jobId, processInfo);
    }

    if (effectiveTimeoutMs > 0) {
      processInfo.timeout_timer = setTimeout(() => {
        requestProcessTimeout(processInfo, effectiveTimeoutMs);
      }, effectiveTimeoutMs);
      processInfo.timeout_timer.unref?.();
    }

    function resolveOnce(value) {
      if (settled) {
        return;
      }

      settled = true;
      finalize();
      resolve(value);
    }

    function rejectOnce(error) {
      if (settled) {
        return;
      }

      settled = true;
      finalize();
      reject(error);
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      if (processInfo.cancel_requested) {
        const cancellationError = createProcessCancellationError(binary, processInfo.cancel_reason, error.signal);
        logWarn('process.command.cancelled', {
          binary,
          duration_ms: Date.now() - startedAt,
          reason: processInfo.cancel_reason,
        });
        rejectOnce(cancellationError);
        return;
      }

      if (processInfo.timeout_requested) {
        const timeoutError = createProcessTimeoutError(binary, processInfo.timeout_ms, error.signal);
        logWarn('process.command.timed_out', {
          binary,
          duration_ms: Date.now() - startedAt,
          timeout_ms: processInfo.timeout_ms,
        });
        rejectOnce(timeoutError);
        return;
      }

      logError('process.command.spawn_failed', {
        binary,
        duration_ms: Date.now() - startedAt,
        error: error.message,
      });
      rejectOnce(error);
    });

    child.on('close', (code, signal) => {
      if (processInfo.cancel_requested) {
        const cancellationError = createProcessCancellationError(binary, processInfo.cancel_reason, signal);
        logWarn('process.command.cancelled', {
          binary,
          duration_ms: Date.now() - startedAt,
          reason: processInfo.cancel_reason,
          exit_signal: signal ?? undefined,
        });
        rejectOnce(cancellationError);
        return;
      }

      if (processInfo.timeout_requested) {
        const timeoutError = createProcessTimeoutError(binary, processInfo.timeout_ms, signal);
        logWarn('process.command.timed_out', {
          binary,
          duration_ms: Date.now() - startedAt,
          timeout_ms: processInfo.timeout_ms,
          exit_signal: signal ?? undefined,
        });
        rejectOnce(timeoutError);
        return;
      }

      if (code === 0) {
        logInfo('process.command.completed', {
          binary,
          duration_ms: Date.now() - startedAt,
          stdout_bytes: Buffer.byteLength(stdout),
          stderr_bytes: Buffer.byteLength(stderr),
        });
        resolveOnce({ stdout, stderr });
        return;
      }

      logError('process.command.failed', {
        binary,
        duration_ms: Date.now() - startedAt,
        exit_code: code,
        exit_signal: signal ?? undefined,
        stderr_excerpt: stderr.trim().length > 1200 ? `...${stderr.trim().slice(-1197)}` : stderr.trim() || undefined,
        stdout_excerpt: stdout.trim().length > 1200 ? `...${stdout.trim().slice(-1197)}` : stdout.trim() || undefined,
      });

      rejectOnce(new Error([
        `${binary} exited with code ${code}.`,
        stderr.trim(),
        stdout.trim(),
      ].filter(Boolean).join('\n')));
    });
  });
}

function getWorkspaceRoot() {
  return path.resolve(process.env.WORKSPACE_ROOT || '/workspace');
}

function resolveWorkspacePath(inputPath, label) {
  const rawPath = ensureNonEmptyString(inputPath, label);
  const workspaceRoot = getWorkspaceRoot();
  const resolvedPath = path.resolve(workspaceRoot, rawPath);
  const relativePath = path.relative(workspaceRoot, resolvedPath);

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`${label} must stay inside WORKSPACE_ROOT (${workspaceRoot}).`);
  }

  return resolvedPath;
}

function resolveBackgroundMusicRoot(value = process.env.BACKGROUND_MUSIC_ROOT ?? process.env.CHANNEL_AUDIO_ROOT) {
  if (typeof value === 'string' && value.trim().length > 0) {
    return path.resolve(value.trim());
  }

  return DEFAULT_BACKGROUND_MUSIC_ROOT;
}

function isSupportedBackgroundMusicFilename(filename) {
  return BACKGROUND_MUSIC_EXTENSIONS.includes(path.extname(filename).toLowerCase());
}

function parseBackgroundMusicId(value, label = 'background_music_id') {
  const normalizedValue = ensureNonEmptyString(value, label);
  const legacyMatch = normalizedValue.match(/^([a-z0-9-]+)\/(long-form|shorts)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/);
  const filename = legacyMatch == null
    ? normalizedValue
    : legacyMatch[3];

  if (
    filename.startsWith('.')
    || filename.includes('/')
    || filename.includes('\\')
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename)
  ) {
    throw new Error(`${label} must be a safe file name. Legacy ${LEGACY_BACKGROUND_MUSIC_ID_FORMAT} is still accepted.`);
  }

  if (!isSupportedBackgroundMusicFilename(filename)) {
    throw new Error(`${label} must use one of: ${BACKGROUND_MUSIC_EXTENSIONS.join(', ')}.`);
  }

  if (legacyMatch != null) {
    ensureEnum(legacyMatch[2], BACKGROUND_MUSIC_COLLECTIONS, `${label}.collection`);
  }

  return {
    id: filename,
    filename,
    legacy_id: legacyMatch == null ? null : normalizedValue,
  };
}

function resolveBundledBackgroundMusicPath(value, label = 'background_music_id') {
  const parsedId = parseBackgroundMusicId(value, label);
  const libraryRoot = resolveBackgroundMusicRoot();
  const resolvedPath = path.resolve(libraryRoot, parsedId.filename);
  const relativePath = path.relative(libraryRoot, resolvedPath);

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`${label} must stay inside the bundled background music library.`);
  }

  try {
    const trackEntry = readdirSync(libraryRoot, { withFileTypes: true })
      .find((entry) => entry.isFile() && entry.name === parsedId.filename);

    if (trackEntry == null) {
      throw new Error(`${label} does not match any bundled background music track: ${parsedId.id}.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('does not match any bundled background music track')) {
      throw error;
    }

    throw new Error(`${label} does not match any bundled background music track: ${parsedId.id}.`);
  }

  return {
    ...parsedId,
    path: resolvedPath,
  };
}

function listBundledBackgroundMusicEntries() {
  const libraryRoot = resolveBackgroundMusicRoot();

  try {
    return readdirSync(libraryRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isSupportedBackgroundMusicFilename(entry.name))
      .map((entry) => ({
        id: entry.name,
        filename: entry.name,
      }))
      .sort((leftEntry, rightEntry) => leftEntry.id.localeCompare(rightEntry.id));
  } catch {
    return [];
  }
}

function buildBundledBackgroundMusicCatalog() {
  return listBundledBackgroundMusicEntries();
}

export function validateSceneAnimation(sceneAnimation, label = 'scene_animation') {
  if (!sceneAnimation || typeof sceneAnimation !== 'object') {
    throw new Error(`${label} must be an object.`);
  }

  return {
    image_motion_preset: ensureEnum(sceneAnimation.image_motion_preset, SCENE_IMAGE_MOTION_PRESETS, `${label}.image_motion_preset`),
    text_motion_preset: ensureEnum(sceneAnimation.text_motion_preset, SCENE_TEXT_MOTION_PRESETS, `${label}.text_motion_preset`),
    speed: ensureEnum(sceneAnimation.speed, SCENE_ANIMATION_SPEEDS, `${label}.speed`),
    text_anchor: ensureEnum(sceneAnimation.text_anchor, SCENE_TEXT_ANCHORS, `${label}.text_anchor`),
  };
}

export function validateSceneTransition(sceneTransition, {
  label = 'transition_to_next',
  allowNone = true,
} = {}) {
  if (!sceneTransition || typeof sceneTransition !== 'object') {
    throw new Error(`${label} must be an object.`);
  }

  const preset = ensureEnum(sceneTransition.preset, SCENE_TRANSITION_PRESETS, `${label}.preset`);
  const durationSeconds = Number(sceneTransition.duration_seconds);

  if (!Number.isFinite(durationSeconds) || durationSeconds < 0 || durationSeconds > 1.2) {
    throw new Error(`${label}.duration_seconds must be between 0 and 1.2.`);
  }

  if (!allowNone && preset === 'none') {
    throw new Error(`${label}.preset must be animated in this position.`);
  }

  if (preset === 'none' && durationSeconds !== 0) {
    throw new Error(`${label}.duration_seconds must be 0 when preset is none.`);
  }

  if (preset !== 'none' && durationSeconds <= 0) {
    throw new Error(`${label}.duration_seconds must be positive for animated transitions.`);
  }

  return {
    preset,
    duration_seconds: Number(formatNumber(durationSeconds, 3)),
  };
}

function getTextAnchorYExpression(textAnchor) {
  switch (textAnchor) {
    case 'upper_third':
      return 'h*0.18';
    case 'center':
      return '(h-text_h)/2';
    case 'lower_third':
      return 'h*0.74-text_h/2';
    default:
      throw new Error(`Unsupported text_anchor: ${textAnchor}`);
  }
}

function clampNumber(value, minValue, maxValue) {
  return Math.min(Math.max(value, minValue), maxValue);
}

function buildSmootherStepExpression(progressExpression) {
  return `(${progressExpression})*(${progressExpression})*(${progressExpression})*((${progressExpression})*((${progressExpression})*6-15)+10)`;
}

function buildBellEnvelopeExpression(progressExpression) {
  return `(4*${progressExpression}*(1-${progressExpression}))`;
}

function buildProgressExpressions(totalFrames) {
  const lastFrameIndex = Math.max(totalFrames - 1, 1);
  const progress = `on/${lastFrameIndex}`;

  // Pure linear progress yields constant velocity across the entire motion,
  // which eliminates the irregular pixel-stepping artefacts that eased curves
  // produce when combined with zoompan's integer x/y truncation.
  return {
    progress,
    easedProgress: progress,
  };
}

function getDurationAwareMotionValue(durationSeconds, {
  minValue,
  maxValue,
  valuePerSecond,
}) {
  return clampNumber(durationSeconds * valuePerSecond, minValue, maxValue);
}

const IMAGE_MOTION_PRESET_CONFIG = Object.freeze({
  static_hold: Object.freeze({
    slow: Object.freeze({ zoomLevel: 1.02 }),
    medium: Object.freeze({ zoomLevel: 1.035 }),
  }),
  slow_push_in: Object.freeze({
    slow: Object.freeze({
      startZoom: 1.02,
      zoomDelta: Object.freeze({ minValue: 0.03, maxValue: 0.10, valuePerSecond: 0.002 }),
    }),
    medium: Object.freeze({
      startZoom: 1.02,
      zoomDelta: Object.freeze({ minValue: 0.05, maxValue: 0.14, valuePerSecond: 0.0028 }),
    }),
  }),
  slow_pull_out: Object.freeze({
    slow: Object.freeze({
      endZoom: 1.02,
      zoomDelta: Object.freeze({ minValue: 0.03, maxValue: 0.10, valuePerSecond: 0.002 }),
    }),
    medium: Object.freeze({
      endZoom: 1.02,
      zoomDelta: Object.freeze({ minValue: 0.05, maxValue: 0.14, valuePerSecond: 0.0028 }),
    }),
  }),
  pan_left_slow: Object.freeze({
    slow: Object.freeze({
      zoomDelta: Object.freeze({ minValue: 0.06, maxValue: 0.22, valuePerSecond: 0.0044 }),
      travelRatio: Object.freeze({ minValue: 0.18, maxValue: 0.45, valuePerSecond: 0.009 }),
    }),
    medium: Object.freeze({
      zoomDelta: Object.freeze({ minValue: 0.09, maxValue: 0.28, valuePerSecond: 0.0056 }),
      travelRatio: Object.freeze({ minValue: 0.22, maxValue: 0.45, valuePerSecond: 0.009 }),
    }),
  }),
  pan_right_slow: Object.freeze({
    slow: Object.freeze({
      zoomDelta: Object.freeze({ minValue: 0.06, maxValue: 0.22, valuePerSecond: 0.0044 }),
      travelRatio: Object.freeze({ minValue: 0.18, maxValue: 0.45, valuePerSecond: 0.009 }),
    }),
    medium: Object.freeze({
      zoomDelta: Object.freeze({ minValue: 0.09, maxValue: 0.28, valuePerSecond: 0.0056 }),
      travelRatio: Object.freeze({ minValue: 0.22, maxValue: 0.45, valuePerSecond: 0.009 }),
    }),
  }),
  drift_up_soft: Object.freeze({
    slow: Object.freeze({
      zoomDelta: Object.freeze({ minValue: 0.06, maxValue: 0.22, valuePerSecond: 0.0044 }),
      travelRatio: Object.freeze({ minValue: 0.18, maxValue: 0.45, valuePerSecond: 0.009 }),
    }),
    medium: Object.freeze({
      zoomDelta: Object.freeze({ minValue: 0.09, maxValue: 0.28, valuePerSecond: 0.0056 }),
      travelRatio: Object.freeze({ minValue: 0.22, maxValue: 0.45, valuePerSecond: 0.009 }),
    }),
  }),
  drift_down_soft: Object.freeze({
    slow: Object.freeze({
      zoomDelta: Object.freeze({ minValue: 0.06, maxValue: 0.22, valuePerSecond: 0.0044 }),
      travelRatio: Object.freeze({ minValue: 0.18, maxValue: 0.45, valuePerSecond: 0.009 }),
    }),
    medium: Object.freeze({
      zoomDelta: Object.freeze({ minValue: 0.09, maxValue: 0.28, valuePerSecond: 0.0056 }),
      travelRatio: Object.freeze({ minValue: 0.22, maxValue: 0.45, valuePerSecond: 0.009 }),
    }),
  }),
  parallax_float: Object.freeze({
    slow: Object.freeze({
      zoomDelta: Object.freeze({ minValue: 0.06, maxValue: 0.22, valuePerSecond: 0.0044 }),
      horizontalTravelRatio: Object.freeze({ minValue: 0.15, maxValue: 0.40, valuePerSecond: 0.008 }),
      verticalAmplitudeRatio: Object.freeze({ minValue: 0.04, maxValue: 0.10, valuePerSecond: 0.002 }),
    }),
    medium: Object.freeze({
      zoomDelta: Object.freeze({ minValue: 0.09, maxValue: 0.28, valuePerSecond: 0.0056 }),
      horizontalTravelRatio: Object.freeze({ minValue: 0.20, maxValue: 0.45, valuePerSecond: 0.009 }),
      verticalAmplitudeRatio: Object.freeze({ minValue: 0.06, maxValue: 0.14, valuePerSecond: 0.0028 }),
    }),
  }),
});

function getImageMotionPresetProfile(imageMotionPreset, speed) {
  const presetConfig = IMAGE_MOTION_PRESET_CONFIG[imageMotionPreset];
  const speedConfig = presetConfig?.[speed];

  if (!speedConfig) {
    throw new Error(`Unsupported image motion preset profile: ${imageMotionPreset}.${speed}`);
  }

  return speedConfig;
}

function buildNormalizedTravelWindow(travelRatio) {
  const clampedTravelRatio = clampNumber(travelRatio, 0, 0.45);
  const startRatio = 0.5 - (clampedTravelRatio / 2);

  return {
    startRatio: formatNumber(startRatio, 3),
    endRatio: formatNumber(startRatio + clampedTravelRatio, 3),
    travelRatio: formatNumber(clampedTravelRatio, 3),
  };
}

function buildImageMotionExpressions(sceneAnimation, {
  durationSeconds,
  totalFrames,
}) {
  const { easedProgress } = buildProgressExpressions(totalFrames);
  const horizontalCenter = 'iw/2-(iw/zoom/2)';
  const verticalCenter = 'ih/2-(ih/zoom/2)';

  switch (sceneAnimation.image_motion_preset) {
    case 'static_hold': {
      const profile = getImageMotionPresetProfile(sceneAnimation.image_motion_preset, sceneAnimation.speed);

      return {
        z: formatNumber(profile.zoomLevel, 3),
        x: horizontalCenter,
        y: verticalCenter,
      };
    }
    case 'slow_push_in': {
      const profile = getImageMotionPresetProfile(sceneAnimation.image_motion_preset, sceneAnimation.speed);
      const zoomDelta = getDurationAwareMotionValue(durationSeconds, profile.zoomDelta);

      return {
        z: `${formatNumber(profile.startZoom, 3)}+${formatNumber(zoomDelta, 3)}*${easedProgress}`,
        x: horizontalCenter,
        y: verticalCenter,
      };
    }
    case 'slow_pull_out': {
      const profile = getImageMotionPresetProfile(sceneAnimation.image_motion_preset, sceneAnimation.speed);
      const zoomDelta = getDurationAwareMotionValue(durationSeconds, profile.zoomDelta);
      const initialZoom = profile.endZoom + zoomDelta;

      return {
        z: `${formatNumber(initialZoom, 3)}-${formatNumber(zoomDelta, 3)}*${easedProgress}`,
        x: horizontalCenter,
        y: verticalCenter,
      };
    }
    case 'pan_left_slow': {
      const profile = getImageMotionPresetProfile(sceneAnimation.image_motion_preset, sceneAnimation.speed);
      const zoomLevel = 1 + getDurationAwareMotionValue(durationSeconds, profile.zoomDelta);
      const travelWindow = buildNormalizedTravelWindow(
        getDurationAwareMotionValue(durationSeconds, profile.travelRatio)
      );

      return {
        z: formatNumber(zoomLevel, 3),
        x: `(iw-iw/zoom)*(${travelWindow.startRatio}+${travelWindow.travelRatio}*${easedProgress})`,
        y: verticalCenter,
      };
    }
    case 'pan_right_slow': {
      const profile = getImageMotionPresetProfile(sceneAnimation.image_motion_preset, sceneAnimation.speed);
      const zoomLevel = 1 + getDurationAwareMotionValue(durationSeconds, profile.zoomDelta);
      const travelWindow = buildNormalizedTravelWindow(
        getDurationAwareMotionValue(durationSeconds, profile.travelRatio)
      );

      return {
        z: formatNumber(zoomLevel, 3),
        x: `(iw-iw/zoom)*(${travelWindow.endRatio}-${travelWindow.travelRatio}*${easedProgress})`,
        y: verticalCenter,
      };
    }
    case 'drift_up_soft': {
      const profile = getImageMotionPresetProfile(sceneAnimation.image_motion_preset, sceneAnimation.speed);
      const zoomLevel = 1 + getDurationAwareMotionValue(durationSeconds, profile.zoomDelta);
      const travelWindow = buildNormalizedTravelWindow(
        getDurationAwareMotionValue(durationSeconds, profile.travelRatio)
      );

      return {
        z: formatNumber(zoomLevel, 3),
        x: horizontalCenter,
        y: `(ih-ih/zoom)*(${travelWindow.endRatio}-${travelWindow.travelRatio}*${easedProgress})`,
      };
    }
    case 'drift_down_soft': {
      const profile = getImageMotionPresetProfile(sceneAnimation.image_motion_preset, sceneAnimation.speed);
      const zoomLevel = 1 + getDurationAwareMotionValue(durationSeconds, profile.zoomDelta);
      const travelWindow = buildNormalizedTravelWindow(
        getDurationAwareMotionValue(durationSeconds, profile.travelRatio)
      );

      return {
        z: formatNumber(zoomLevel, 3),
        x: horizontalCenter,
        y: `(ih-ih/zoom)*(${travelWindow.startRatio}+${travelWindow.travelRatio}*${easedProgress})`,
      };
    }
    case 'parallax_float': {
      const profile = getImageMotionPresetProfile(sceneAnimation.image_motion_preset, sceneAnimation.speed);
      const zoomLevel = 1 + getDurationAwareMotionValue(durationSeconds, profile.zoomDelta);
      const horizontalTravelWindow = buildNormalizedTravelWindow(
        getDurationAwareMotionValue(durationSeconds, profile.horizontalTravelRatio)
      );
      const verticalAmplitudeRatio = getDurationAwareMotionValue(durationSeconds, profile.verticalAmplitudeRatio);
      const verticalFloatEnvelope = buildBellEnvelopeExpression(easedProgress);

      return {
        z: formatNumber(zoomLevel, 3),
        x: `(iw-iw/zoom)*(${horizontalTravelWindow.startRatio}+${horizontalTravelWindow.travelRatio}*${easedProgress})`,
        y: `(ih-ih/zoom)*(0.5+${formatNumber(verticalAmplitudeRatio, 3)}*${verticalFloatEnvelope})`,
      };
    }
    default:
      throw new Error(`Unsupported image motion preset: ${sceneAnimation.image_motion_preset}`);
  }
}

function buildTextAnimationExpressions(sceneAnimation, durationSeconds) {
  const baseX = '(w-text_w)/2';
  const baseY = getTextAnchorYExpression(sceneAnimation.text_anchor);
  const textIntroDurationSeconds = clampNumber(
    durationSeconds * 0.1,
    0.45,
    sceneAnimation.speed === 'slow' ? 0.95 : 0.8
  );
  const textIntroDuration = formatNumber(textIntroDurationSeconds, 3);
  const introProgress = `min(t/${textIntroDuration},1)`;
  const introEase = buildSmootherStepExpression(introProgress);
  const introRemaining = `(1-${introEase})`;
  const fadeInAlpha = `if(lt(t,${textIntroDuration}),t/${textIntroDuration},1)`;
  const verticalOffset = formatNumber(
    clampNumber(durationSeconds * (sceneAnimation.speed === 'slow' ? 0.45 : 0.6), 22, 38),
    3
  );
  const horizontalOffset = formatNumber(
    clampNumber(durationSeconds * (sceneAnimation.speed === 'slow' ? 0.95 : 1.2), 44, 82),
    3
  );
  const typeOnDelaySeconds = clampNumber(textIntroDurationSeconds * 0.18, 0.08, 0.16);
  const typeOnDelay = formatNumber(typeOnDelaySeconds, 3);
  const typeOnRevealSpan = formatNumber(Math.max(textIntroDurationSeconds - typeOnDelaySeconds, 0.2), 3);

  switch (sceneAnimation.text_motion_preset) {
    case 'fade_in_hold':
      return { x: baseX, y: baseY, alpha: fadeInAlpha };
    case 'fade_up_soft':
      return { x: baseX, y: `${baseY}+${verticalOffset}*${introRemaining}`, alpha: fadeInAlpha };
    case 'slide_left_soft':
      return { x: `${baseX}+${horizontalOffset}*${introRemaining}`, y: baseY, alpha: fadeInAlpha };
    case 'slide_right_soft':
      return { x: `${baseX}-${horizontalOffset}*${introRemaining}`, y: baseY, alpha: fadeInAlpha };
    case 'type_on_soft':
      return { x: baseX, y: baseY, alpha: `if(lt(t,${typeOnDelay}),0,if(lt(t,${textIntroDuration}),(t-${typeOnDelay})/${typeOnRevealSpan},1))` };
    default:
      throw new Error(`Unsupported text motion preset: ${sceneAnimation.text_motion_preset}`);
  }
}

export function buildImageTextSceneFilterGraph({
  sceneAnimation,
  overlayText,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  fps = DEFAULT_FPS,
  durationSeconds,
  fontFile = process.env.FONT_FILE || '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  fontSize = DEFAULT_FONT_SIZE,
  fontColor = DEFAULT_FONT_COLOR,
  borderColor = DEFAULT_BORDER_COLOR,
}) {
  const normalizedSceneAnimation = validateSceneAnimation(sceneAnimation);
  const normalizedOverlayText = normalizeNullableString(overlayText, 'overlay_text');
  const normalizedWidth = normalizePositiveInteger(width, DEFAULT_WIDTH, 'width');
  const normalizedHeight = normalizePositiveInteger(height, DEFAULT_HEIGHT, 'height');
  const normalizedFps = normalizePositiveInteger(fps, DEFAULT_FPS, 'fps');
  const normalizedDurationSeconds = normalizePositiveNumber(durationSeconds, 5, 'duration_seconds');
  const normalizedFontSize = normalizePositiveInteger(fontSize, DEFAULT_FONT_SIZE, 'font_size');
  const totalFrames = Math.max(Math.round(normalizedDurationSeconds * normalizedFps), 2);
  const sourceWidth = Math.ceil(normalizedWidth * 6);
  const sourceHeight = Math.ceil(normalizedHeight * 6);
  const imageMotion = buildImageMotionExpressions(normalizedSceneAnimation, {
    durationSeconds: normalizedDurationSeconds,
    totalFrames,
    sourceWidth,
    sourceHeight,
  });
  const textMotion = buildTextAnimationExpressions(normalizedSceneAnimation, normalizedDurationSeconds);

  const imageChain = [
    `[0:v]scale=${sourceWidth}:${sourceHeight}:force_original_aspect_ratio=increase`,
    `crop=${sourceWidth}:${sourceHeight}`,
    `zoompan=z='${escapeExpression(imageMotion.z)}':x='${escapeExpression(imageMotion.x)}':y='${escapeExpression(imageMotion.y)}':d=${totalFrames}:s=${normalizedWidth}x${normalizedHeight}:fps=${normalizedFps}`,
    `tmix=frames=2:weights='1 1'[img]`,
  ].join(',');

  if (normalizedOverlayText == null) {
    return `${imageChain};[img]format=yuv420p[vout]`;
  }

  const textChain = [
    `[img]drawtext=fontfile='${escapeFilterLiteral(fontFile)}':text='${escapeDrawtextText(normalizedOverlayText)}':fontcolor=${fontColor}:fontsize=${normalizedFontSize}:x='${escapeExpression(textMotion.x)}':y='${escapeExpression(textMotion.y)}':alpha='${escapeExpression(textMotion.alpha)}':borderw=4:bordercolor=${borderColor}:shadowcolor=black@0.85:shadowx=2:shadowy=2:line_spacing=8`,
    'format=yuv420p[vout]',
  ].join(',');

  return `${imageChain};${textChain}`;
}

function normalizeClipEntry(clip, index) {
  if (!clip || typeof clip !== 'object') {
    throw new Error(`clips[${index}] must be an object.`);
  }

  const clipPath = clip.clip_path ?? clip.path;

  return {
    clip_path: ensureNonEmptyString(clipPath, `clips[${index}].clip_path`),
    transition_to_next: validateSceneTransition(
      clip.transition_to_next,
      { label: `clips[${index}].transition_to_next` }
    ),
  };
}

function normalizeJoinClipsRequestEntry(clip, index) {
  if (!clip || typeof clip !== 'object') {
    throw new Error(`clips[${index}] must be an object.`);
  }

  const clipPath = clip.clip_path ?? clip.path;
  const clipBinary = clip.clip_binary ?? clip.clipBinary;
  const subtitlePath = clip.subtitle_path ?? clip.subtitlePath;
  const subtitleBinary = clip.subtitle_binary ?? clip.subtitleBinary;

  if (clipPath == null && clipBinary == null) {
    throw new Error(`clips[${index}] must include clip_path or clip_binary.`);
  }

  if (clipPath != null && clipBinary != null) {
    throw new Error(`clips[${index}] must not include both clip_path and clip_binary.`);
  }

  if (subtitlePath != null && subtitleBinary != null) {
    throw new Error(`clips[${index}] must not include both subtitle_path and subtitle_binary.`);
  }

  return {
    clip_path: clipPath == null ? null : ensureNonEmptyString(clipPath, `clips[${index}].clip_path`),
    clip_binary: clipBinary ?? null,
    subtitle_path: subtitlePath == null ? null : ensureNonEmptyString(subtitlePath, `clips[${index}].subtitle_path`),
    subtitle_binary: subtitleBinary ?? null,
    transition_to_next: validateSceneTransition(
      clip.transition_to_next,
      { label: `clips[${index}].transition_to_next` }
    ),
  };
}

function normalizeJoinClipsBackgroundMusicRequest(requestBody) {
  const backgroundMusicId = requestBody.background_music_id ?? requestBody.backgroundMusicId;

  return {
    background_music_id: backgroundMusicId == null
      ? null
      : ensureNonEmptyString(backgroundMusicId, 'background_music_id'),
  };
}

export function buildJoinClipsFilterGraph({
  clips,
  durations,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  fps = DEFAULT_FPS,
}) {
  if (!Array.isArray(clips) || clips.length === 0) {
    throw new Error('clips must be a non-empty array.');
  }

  if (!Array.isArray(durations) || durations.length !== clips.length) {
    throw new Error('durations must be an array with the same length as clips.');
  }

  const normalizedClips = clips.map(normalizeClipEntry);
  const normalizedDurations = durations.map((duration, index) => normalizePositiveNumber(duration, null, `durations[${index}]`));
  const normalizedWidth = normalizePositiveInteger(width, DEFAULT_WIDTH, 'width');
  const normalizedHeight = normalizePositiveInteger(height, DEFAULT_HEIGHT, 'height');
  const normalizedFps = normalizePositiveInteger(fps, DEFAULT_FPS, 'fps');

  normalizedClips.forEach((clip, index) => {
    if (index < normalizedClips.length - 1 && clip.transition_to_next.preset === 'none') {
      throw new Error(`clips[${index}].transition_to_next must be animated before another clip.`);
    }

    if (index === normalizedClips.length - 1 && clip.transition_to_next.preset !== 'none') {
      throw new Error('The last clip must use transition_to_next.preset = none.');
    }
  });

  const filterParts = normalizedClips.map((_, index) => (
    `[${index}:v]fps=${normalizedFps},scale=${normalizedWidth}:${normalizedHeight}:force_original_aspect_ratio=increase,crop=${normalizedWidth}:${normalizedHeight},format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[v${index}]`
  ));

  if (normalizedClips.length === 1) {
    return {
      filterGraph: filterParts.join(';'),
      outputLabel: 'v0',
      totalDurationSeconds: normalizedDurations[0],
    };
  }

  let currentLabel = 'v0';
  let cumulativeDuration = normalizedDurations[0];

  for (let index = 1; index < normalizedClips.length; index += 1) {
    const transition = normalizedClips[index - 1].transition_to_next;
    const nextLabel = index === normalizedClips.length - 1 ? 'vout' : `vx${index}`;
    const offsetSeconds = cumulativeDuration - transition.duration_seconds;

    filterParts.push(
      `[${currentLabel}][v${index}]xfade=transition=${XFADE_TRANSITIONS[transition.preset]}:duration=${formatNumber(transition.duration_seconds, 3)}:offset=${formatNumber(offsetSeconds, 3)}[${nextLabel}]`
    );

    cumulativeDuration += normalizedDurations[index] - transition.duration_seconds;
    currentLabel = nextLabel;
  }

  return {
    filterGraph: filterParts.join(';'),
    outputLabel: currentLabel,
    totalDurationSeconds: Number(formatNumber(cumulativeDuration, 3)),
  };
}

export function buildJoinClipsAudioFilterGraph({
  clips,
  durations,
  audioTracks,
  audioSampleRate = DEFAULT_AUDIO_SAMPLE_RATE,
  backgroundMusic = null,
}) {
  if (!Array.isArray(clips) || clips.length === 0) {
    throw new Error('clips must be a non-empty array.');
  }

  if (!Array.isArray(durations) || durations.length !== clips.length) {
    throw new Error('durations must be an array with the same length as clips.');
  }

  if (!Array.isArray(audioTracks) || audioTracks.length !== clips.length) {
    throw new Error('audioTracks must be an array with the same length as clips.');
  }

  const normalizedClips = clips.map(normalizeClipEntry);
  const normalizedDurations = durations.map((duration, index) => normalizePositiveNumber(duration, null, `durations[${index}]`));
  const normalizedAudioSampleRate = normalizePositiveInteger(audioSampleRate, DEFAULT_AUDIO_SAMPLE_RATE, 'audio_sample_rate');
  const filterParts = [];
  const inputLabels = [];
  const hasSceneAudio = audioTracks.some(Boolean);
  let totalDurationSeconds = 0;

  normalizedClips.forEach((clip, index) => {
    const segmentDuration = index === normalizedClips.length - 1
      ? normalizedDurations[index]
      : normalizedDurations[index] - clip.transition_to_next.duration_seconds;

    if (!Number.isFinite(segmentDuration) || segmentDuration <= 0) {
      throw new Error(`Audio segment ${index} must have a positive duration after transition trimming.`);
    }

    const normalizedSegmentDuration = formatNumber(segmentDuration, 3);
    const outputLabel = `a${index}`;

    if (hasSceneAudio) {
      if (audioTracks[index]) {
        filterParts.push(
          `[${index}:a]aresample=${normalizedAudioSampleRate},aformat=sample_rates=${normalizedAudioSampleRate}:channel_layouts=stereo,apad=whole_dur=${normalizedSegmentDuration},atrim=duration=${normalizedSegmentDuration},asetpts=PTS-STARTPTS[${outputLabel}]`
        );
      } else {
        filterParts.push(
          `anullsrc=r=${normalizedAudioSampleRate}:cl=stereo,atrim=duration=${normalizedSegmentDuration},asetpts=PTS-STARTPTS[${outputLabel}]`
        );
      }

      inputLabels.push(`[${outputLabel}]`);
    }

    totalDurationSeconds += segmentDuration;
  });

  const normalizedTotalDurationSeconds = Number(formatNumber(totalDurationSeconds, 3));
  const sceneAudioLabel = hasSceneAudio
    ? (inputLabels.length > 1 ? 'ascenes' : 'a0')
    : null;

  if (hasSceneAudio && inputLabels.length > 1) {
    filterParts.push(`${inputLabels.join('')}concat=n=${inputLabels.length}:v=0:a=1[ascenes]`);
  }

  if (backgroundMusic != null) {
    filterParts.push(buildPreparedAudioStreamFilter({
      inputIndex: normalizedClips.length,
      audioSampleRate: normalizedAudioSampleRate,
      durationSeconds: normalizedTotalDurationSeconds,
      volume: backgroundMusic.mix.volume,
      fadeInSeconds: backgroundMusic.mix.fade_in_seconds,
      fadeOutSeconds: backgroundMusic.mix.fade_out_seconds,
      outputLabel: sceneAudioLabel == null ? 'aout' : 'abg',
    }));

    if (sceneAudioLabel != null) {
      let musicLabel = 'abg';
      let mixSceneAudioLabel = sceneAudioLabel;

      if (backgroundMusic.mix.ducking_enabled) {
        filterParts.push(
          `[${sceneAudioLabel}]asplit=2[ascenesduck][ascenesmix]`
        );
        filterParts.push(
          `[abg][ascenesduck]sidechaincompress=threshold=${formatNumber(DEFAULT_BACKGROUND_MUSIC_DUCKING_THRESHOLD, 3)}:ratio=${formatNumber(DEFAULT_BACKGROUND_MUSIC_DUCKING_RATIO, 3)}:attack=${DEFAULT_BACKGROUND_MUSIC_DUCKING_ATTACK_MS}:release=${DEFAULT_BACKGROUND_MUSIC_DUCKING_RELEASE_MS}[abgduck]`
        );
        musicLabel = 'abgduck';
        mixSceneAudioLabel = 'ascenesmix';
      }

      filterParts.push(
        `[${musicLabel}][${mixSceneAudioLabel}]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`
      );
    }
  }

  return {
    filterGraph: filterParts.join(';'),
    outputLabel: backgroundMusic != null ? 'aout' : sceneAudioLabel,
    totalDurationSeconds: normalizedTotalDurationSeconds,
  };
}

async function probeClipDuration(clipPath) {
  const { stdout } = await runCommand('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    clipPath,
  ]);

  const durationSeconds = Number.parseFloat(stdout.trim());

  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`Could not determine clip duration for ${clipPath}.`);
  }

  return durationSeconds;
}

async function probeClipStreamInfo(clipPath) {
  const { stdout } = await runCommand('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type,duration',
    '-show_entries',
    'format=duration',
    '-of',
    'json',
    clipPath,
  ]);

  const probeResult = JSON.parse(stdout);
  const streams = Array.isArray(probeResult.streams) ? probeResult.streams : [];
  const videoStream = streams.find((stream) => stream.codec_type === 'video');
  const audioStream = streams.find((stream) => stream.codec_type === 'audio');
  const videoDurationSeconds = Number.parseFloat(videoStream?.duration ?? probeResult.format?.duration ?? '');

  if (!Number.isFinite(videoDurationSeconds) || videoDurationSeconds <= 0) {
    throw new Error(`Could not determine video duration for ${clipPath}.`);
  }

  return {
    video_duration_seconds: videoDurationSeconds,
    has_audio: audioStream != null,
  };
}

function normalizeCodec(codec) {
  return normalizeOptionalString(codec, DEFAULT_VIDEO_CODEC);
}

function normalizeEncodePreset(value) {
  return normalizeOptionalString(value, DEFAULT_ENCODE_PRESET);
}

export function getAdaptiveEncodePreset(requestedPreset, durationSeconds) {
  if (requestedPreset != null) {
    return normalizeEncodePreset(requestedPreset);
  }

  return durationSeconds >= LONG_RENDER_THRESHOLD_SECONDS
    ? LONG_RENDER_ENCODE_PRESET
    : DEFAULT_ENCODE_PRESET;
}

function normalizeCrf(value) {
  const numericValue = value == null ? DEFAULT_CRF : Number(value);
  if (!Number.isInteger(numericValue) || numericValue < 0 || numericValue > 51) {
    throw new Error('crf must be an integer between 0 and 51.');
  }
  return numericValue;
}

function normalizeVoiceoverMix(voiceoverMix, durationSeconds) {
  if (voiceoverMix == null) {
    return {
      volume: 1,
      fade_out_seconds: 0,
    };
  }

  if (typeof voiceoverMix !== 'object') {
    throw new Error('voiceover_mix must be an object.');
  }

  const volume = normalizePositiveNumber(voiceoverMix.volume, 1, 'voiceover_mix.volume');
  const fadeOutSeconds = normalizeNonNegativeNumber(
    voiceoverMix.fade_out_seconds ?? voiceoverMix.fadeOutSeconds,
    0,
    'voiceover_mix.fade_out_seconds'
  );

  if (fadeOutSeconds >= durationSeconds) {
    throw new Error('voiceover_mix.fade_out_seconds must be shorter than duration_seconds.');
  }

  return {
    volume: Number(formatNumber(volume, 3)),
    fade_out_seconds: Number(formatNumber(fadeOutSeconds, 3)),
  };
}

function resolveDefaultAudioFadeSeconds(defaultSeconds, durationSeconds) {
  return Number(formatNumber(
    Math.min(defaultSeconds, Math.max(Number(durationSeconds) - 0.05, 0)),
    3,
  ));
}

function normalizeBackgroundMusicMix(backgroundMusicMix, durationSeconds) {
  const defaultFadeInSeconds = resolveDefaultAudioFadeSeconds(
    DEFAULT_BACKGROUND_MUSIC_FADE_IN_SECONDS,
    durationSeconds,
  );
  const defaultFadeOutSeconds = resolveDefaultAudioFadeSeconds(
    DEFAULT_BACKGROUND_MUSIC_FADE_OUT_SECONDS,
    durationSeconds,
  );

  if (backgroundMusicMix == null) {
    return {
      volume: DEFAULT_BACKGROUND_MUSIC_VOLUME,
      fade_in_seconds: defaultFadeInSeconds,
      fade_out_seconds: defaultFadeOutSeconds,
      loop: DEFAULT_BACKGROUND_MUSIC_LOOP,
      ducking_enabled: DEFAULT_BACKGROUND_MUSIC_DUCKING_ENABLED,
    };
  }

  if (typeof backgroundMusicMix !== 'object') {
    throw new Error('background_music_mix must be an object.');
  }

  const volume = normalizePositiveNumber(
    backgroundMusicMix.volume,
    DEFAULT_BACKGROUND_MUSIC_VOLUME,
    'background_music_mix.volume'
  );
  const fadeInSeconds = normalizeNonNegativeNumber(
    backgroundMusicMix.fade_in_seconds ?? backgroundMusicMix.fadeInSeconds,
    defaultFadeInSeconds,
    'background_music_mix.fade_in_seconds'
  );
  const fadeOutSeconds = normalizeNonNegativeNumber(
    backgroundMusicMix.fade_out_seconds ?? backgroundMusicMix.fadeOutSeconds,
    defaultFadeOutSeconds,
    'background_music_mix.fade_out_seconds'
  );
  const loop = normalizeOptionalBoolean(
    backgroundMusicMix.loop,
    DEFAULT_BACKGROUND_MUSIC_LOOP,
    'background_music_mix.loop'
  );
  const duckingEnabled = normalizeOptionalBoolean(
    backgroundMusicMix.ducking_enabled ?? backgroundMusicMix.duckingEnabled,
    DEFAULT_BACKGROUND_MUSIC_DUCKING_ENABLED,
    'background_music_mix.ducking_enabled'
  );

  if (volume > 1) {
    throw new Error('background_music_mix.volume must stay at or below 1.');
  }

  if (fadeInSeconds > 5) {
    throw new Error('background_music_mix.fade_in_seconds must stay at or below 5.');
  }

  if (fadeOutSeconds > 5) {
    throw new Error('background_music_mix.fade_out_seconds must stay at or below 5.');
  }

  if (fadeInSeconds >= durationSeconds) {
    throw new Error('background_music_mix.fade_in_seconds must be shorter than duration_seconds.');
  }

  if (fadeOutSeconds >= durationSeconds) {
    throw new Error('background_music_mix.fade_out_seconds must be shorter than duration_seconds.');
  }

  return {
    volume: Number(formatNumber(volume, 3)),
    fade_in_seconds: Number(formatNumber(fadeInSeconds, 3)),
    fade_out_seconds: Number(formatNumber(fadeOutSeconds, 3)),
    loop,
    ducking_enabled: duckingEnabled,
  };
}

function normalizeAudioCodec(codec) {
  return normalizeOptionalString(codec, DEFAULT_AUDIO_CODEC);
}

function normalizeAudioBitrate(value) {
  return normalizeOptionalString(value, DEFAULT_AUDIO_BITRATE);
}

function normalizeAudioSampleRate(value) {
  return normalizePositiveInteger(value, DEFAULT_AUDIO_SAMPLE_RATE, 'audio_sample_rate');
}

function normalizeLanguageCode(value, label) {
  const normalizedValue = normalizeOptionalString(value, DEFAULT_SUBTITLE_LANGUAGE)
    .replace(/_/g, '-')
    .toLowerCase();

  if (!/^[a-z]{2,3}(?:-[a-z0-9]+)*$/.test(normalizedValue)) {
    throw new Error(`${label} must be a language code like es or en.`);
  }

  return normalizedValue;
}

function normalizeSubtitleTheme(value) {
  const normalizedValue = normalizeOptionalString(value, DEFAULT_SUBTITLE_THEME).toLowerCase();
  return ensureEnum(normalizedValue, Object.keys(SUBTITLE_THEME_PROFILES), 'subtitle_theme');
}

function normalizeSubtitleDelivery(value) {
  const normalizedValue = normalizeOptionalString(value, DEFAULT_SUBTITLE_DELIVERY).toLowerCase();
  return ensureEnum(normalizedValue, SUBTITLE_DELIVERY_OPTIONS, 'subtitle_delivery');
}

function getSubtitleThemeProfile(theme) {
  return SUBTITLE_THEME_PROFILES[normalizeSubtitleTheme(theme)];
}

export function getScaledSubtitleThemeProfile(subtitleTheme, width = SUBTITLE_LAYOUT_BASE_WIDTH, height = SUBTITLE_LAYOUT_BASE_HEIGHT) {
  const themeProfile = getSubtitleThemeProfile(subtitleTheme);
  const normalizedWidth = normalizePositiveInteger(width, SUBTITLE_LAYOUT_BASE_WIDTH, 'width');
  const normalizedHeight = normalizePositiveInteger(height, SUBTITLE_LAYOUT_BASE_HEIGHT, 'height');
  const layoutScale = Math.min(
    normalizedWidth / SUBTITLE_LAYOUT_BASE_WIDTH,
    normalizedHeight / SUBTITLE_LAYOUT_BASE_HEIGHT,
    1,
  );

  return {
    ...themeProfile,
    font_size: Math.min(themeProfile.font_size, Math.max(Math.round(themeProfile.font_size * layoutScale), 12)),
    margin_l: Math.min(themeProfile.margin_l, Math.max(Math.round(themeProfile.margin_l * layoutScale), 24)),
    margin_r: Math.min(themeProfile.margin_r, Math.max(Math.round(themeProfile.margin_r * layoutScale), 24)),
    margin_v: Math.min(themeProfile.margin_v, Math.max(Math.round(themeProfile.margin_v * layoutScale), 20)),
  };
}

function resolveSubtitleTextLayout(scaledThemeProfile, width, height) {
  const normalizedWidth = normalizePositiveInteger(width, SUBTITLE_LAYOUT_BASE_WIDTH, 'width');
  const normalizedHeight = normalizePositiveInteger(height, SUBTITLE_LAYOUT_BASE_HEIGHT, 'height');
  const isPortraitOrNarrow = normalizedHeight > normalizedWidth || normalizedWidth < 900;
  const maxLineCount = isPortraitOrNarrow ? 3 : 2;
  const availableWidth = Math.max(normalizedWidth - scaledThemeProfile.margin_l - scaledThemeProfile.margin_r, 120);
  const averageCharacterWidth = Math.max(
    scaledThemeProfile.font_size * (scaledThemeProfile.uppercase ? 0.78 : 0.68),
    1,
  );
  const maxLineWidthCap = normalizedWidth <= 540 ? 18 : isPortraitOrNarrow ? 24 : 32;
  const maxLineWidth = Math.max(12, Math.min(Math.floor(availableWidth / averageCharacterWidth), maxLineWidthCap));

  return {
    max_line_width: maxLineWidth,
    max_line_count: maxLineCount,
  };
}

function buildSubtitleForceStyle(subtitleTheme, width = SUBTITLE_LAYOUT_BASE_WIDTH, height = SUBTITLE_LAYOUT_BASE_HEIGHT) {
  const themeProfile = getScaledSubtitleThemeProfile(subtitleTheme, width, height);

  return [
    `FontName=${themeProfile.font_name}`,
    `Fontsize=${themeProfile.font_size}`,
    `PrimaryColour=${themeProfile.base_colour}`,
    `OutlineColour=${themeProfile.outline_colour}`,
    `BackColour=${themeProfile.back_colour}`,
    `Bold=${themeProfile.bold}`,
    `Alignment=${themeProfile.alignment}`,
    `MarginL=${themeProfile.margin_l}`,
    `MarginR=${themeProfile.margin_r}`,
    `MarginV=${themeProfile.margin_v}`,
    'BorderStyle=1',
    'Outline=2',
    'Shadow=0',
  ].join(',');
}

function buildAssSubtitleForceStyle(subtitleTheme, width = SUBTITLE_LAYOUT_BASE_WIDTH, height = SUBTITLE_LAYOUT_BASE_HEIGHT) {
  const themeProfile = getScaledSubtitleThemeProfile(subtitleTheme, width, height);
  const normalizedWidth = normalizePositiveInteger(width, SUBTITLE_LAYOUT_BASE_WIDTH, 'width');
  const normalizedHeight = normalizePositiveInteger(height, SUBTITLE_LAYOUT_BASE_HEIGHT, 'height');
  const horizontalScale = normalizedWidth / LIBASS_DEFAULT_PLAYRES_X;
  const verticalScale = normalizedHeight / LIBASS_DEFAULT_PLAYRES_Y;

  return [
    `FontName=${themeProfile.font_name}`,
    `Fontsize=${Math.max(Math.round(themeProfile.font_size * verticalScale), themeProfile.font_size)}`,
    `PrimaryColour=${themeProfile.highlight_colour}`,
    `SecondaryColour=${themeProfile.base_colour}`,
    `OutlineColour=${themeProfile.outline_colour}`,
    `BackColour=${themeProfile.back_colour}`,
    `Bold=${themeProfile.bold}`,
    `Alignment=${themeProfile.alignment}`,
    `MarginL=${Math.max(Math.round(themeProfile.margin_l * horizontalScale), themeProfile.margin_l)}`,
    `MarginR=${Math.max(Math.round(themeProfile.margin_r * horizontalScale), themeProfile.margin_r)}`,
    `MarginV=${Math.max(Math.round(themeProfile.margin_v * verticalScale), themeProfile.margin_v)}`,
    'BorderStyle=1',
    `Outline=${Math.max(Math.round(DEFAULT_SUBTITLE_OUTLINE * verticalScale), DEFAULT_SUBTITLE_OUTLINE)}`,
    'Shadow=0',
  ].join(',');
}

function resolveWhisperxPythonBinary() {
  return normalizeOptionalString(
    process.env.WHISPERX_PYTHON
      ?? process.env.WHISPERX_PYTHON_BINARY,
    'python3'
  );
}

function resolveWhisperxDevice() {
  return normalizeOptionalString(process.env.WHISPERX_DEVICE, DEFAULT_SUBTITLE_DEVICE);
}

function resolveWhisperxModelCacheDir() {
  return normalizeNullableString(process.env.WHISPERX_MODEL_CACHE_DIR, 'WHISPERX_MODEL_CACHE_DIR');
}

function normalizeGenerateClipSubtitleRequest(requestBody, audio) {
  const audioTextValue = requestBody.audio_text ?? requestBody.audioText;

  if (audioTextValue == null) {
    return null;
  }

  if (audio?.voiceover_path == null) {
    throw new Error('audio_text requires voiceover_binary.');
  }

  const subtitleDelivery = normalizeSubtitleDelivery(
    requestBody.subtitle_delivery
      ?? requestBody.subtitleDelivery
      ?? process.env.WHISPERX_SUBTITLE_DELIVERY,
  );
  const highlightWords = normalizeOptionalBoolean(
    requestBody.subtitle_highlight_words
      ?? requestBody.subtitleHighlightWords
      ?? requestBody.highlight_words
      ?? requestBody.highlightWords,
    false,
    'subtitle_highlight_words'
  );

  if (subtitleDelivery === 'external' && highlightWords) {
    throw new Error('subtitle_highlight_words is only supported with subtitle_delivery=burned.');
  }

  return {
    audio_text: ensureNonEmptyString(audioTextValue, 'audio_text'),
    audio_language: normalizeLanguageCode(
      requestBody.audio_language
        ?? requestBody.audioLanguage
        ?? process.env.WHISPERX_DEFAULT_LANGUAGE,
      'audio_language'
    ),
    subtitle_theme: normalizeSubtitleTheme(
      requestBody.subtitle_theme
        ?? requestBody.subtitleTheme
        ?? process.env.WHISPERX_SUBTITLE_THEME,
    ),
    subtitle_delivery: subtitleDelivery,
    highlight_words: highlightWords,
  };
}

async function createAlignedSubtitleTrack({
  audioPath,
  audioText,
  audioLanguage,
  subtitleTheme,
  subtitleDelivery = DEFAULT_SUBTITLE_DELIVERY,
  highlightWords = false,
  width,
  height,
  outputDir,
}) {
  const scaledThemeProfile = getScaledSubtitleThemeProfile(subtitleTheme, width, height);
  const subtitleTextLayout = resolveSubtitleTextLayout(scaledThemeProfile, width, height);
  const transcriptPath = path.join(outputDir, 'voiceover-transcript.txt');
  const subtitleExtension = subtitleDelivery === 'external'
    ? '.srt'
    : highlightWords
      ? '.ass'
      : '.srt';
  const subtitlePath = path.join(outputDir, `voiceover-subtitles${subtitleExtension}`);
  const whisperxArgs = [
    WHISPERX_ALIGN_SCRIPT_PATH,
    '--audio-path',
    audioPath,
    '--transcript-path',
    transcriptPath,
    '--output-path',
    subtitlePath,
    '--language',
    audioLanguage,
    '--device',
    resolveWhisperxDevice(),
    '--playres-x',
    String(normalizePositiveInteger(width, DEFAULT_WIDTH, 'width')),
    '--playres-y',
    String(normalizePositiveInteger(height, DEFAULT_HEIGHT, 'height')),
    '--max-line-width',
    String(subtitleTextLayout.max_line_width),
    '--max-line-count',
    String(subtitleTextLayout.max_line_count),
    '--theme',
    subtitleTheme,
  ];
  const modelCacheDir = resolveWhisperxModelCacheDir();

  if (modelCacheDir != null) {
    whisperxArgs.push('--model-cache-dir', modelCacheDir);
  }

  if (highlightWords) {
    whisperxArgs.push('--highlight-words');
  }

  await writeFile(transcriptPath, `${audioText}\n`, 'utf8');

  logInfo('render.generate_clip.subtitles.started', {
    subtitle_language: audioLanguage,
    subtitle_theme: subtitleTheme,
    subtitle_highlight_words: highlightWords,
  });

  await runCommand(resolveWhisperxPythonBinary(), whisperxArgs);

  logInfo('render.generate_clip.subtitles.completed', {
    subtitle_language: audioLanguage,
    subtitle_theme: subtitleTheme,
    subtitle_highlight_words: highlightWords,
    subtitle_path: subtitlePath,
  });

  return {
    subtitle_path: subtitlePath,
    subtitle_language: audioLanguage,
    subtitle_theme: subtitleTheme,
    subtitle_content_type: SRT_CONTENT_TYPE,
    delivery: subtitleDelivery,
    highlight_words: highlightWords,
    force_style: highlightWords
      ? buildAssSubtitleForceStyle(subtitleTheme, width, height)
      : buildSubtitleForceStyle(subtitleTheme, width, height),
  };
}

function normalizeBinaryBuffer(value, label) {
  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }

  throw new Error(`${label} must be a Buffer, Uint8Array, or ArrayBuffer.`);
}

function getUploadBase64Field(upload) {
  if (upload.base64 != null) {
    return {
      field: 'base64',
      value: upload.base64,
    };
  }

  if (upload.data != null) {
    return {
      field: 'data',
      value: upload.data,
    };
  }

  return null;
}

function getUploadFilename(upload, label) {
  const filename = upload.filename ?? upload.fileName;
  return filename == null ? '' : ensureNonEmptyString(filename, `${label}.filename`);
}

function getUploadMimeType(upload, label) {
  const mimeType = upload.mime_type ?? upload.mimeType;
  return mimeType == null ? '' : ensureNonEmptyString(mimeType, `${label}.mime_type`);
}

function getUploadFilePath(upload, label) {
  const filePath = upload.file_path ?? upload.filePath;
  return filePath == null ? '' : ensureNonEmptyString(filePath, `${label}.file_path`);
}

function getUploadSizeBytes(upload) {
  if (!upload || typeof upload !== 'object') {
    return 0;
  }

  if (getUploadFilePath(upload, 'upload') !== '') {
    return 0;
  }

  if (upload.file != null) {
    return Number(upload.size_bytes ?? upload.file.size ?? 0);
  }

  if (upload.buffer != null) {
    return normalizeBinaryBuffer(upload.buffer, 'upload.buffer').length;
  }

  const uploadBase64Field = getUploadBase64Field(upload);
  if (uploadBase64Field != null) {
    return Buffer.from(
      normalizeBase64UploadValue(uploadBase64Field.value, `upload.${uploadBase64Field.field}`),
      'base64'
    ).length;
  }

  return 0;
}

function normalizeBase64UploadValue(value, label) {
  const rawValue = ensureNonEmptyString(value, label)
    .trim()
    .replace(/^data:[^,]*;base64,/i, '')
    .replace(/\s+/g, '');

  const normalizedValue = rawValue
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalizedValue)) {
    throw new Error(`${label} must be valid base64.`);
  }

  const remainder = normalizedValue.length % 4;
  if (remainder === 1) {
    throw new Error(`${label} must be valid base64.`);
  }

  if (remainder === 0) {
    return normalizedValue;
  }

  return normalizedValue.padEnd(normalizedValue.length + (4 - remainder), '=');
}

async function normalizeBinaryUpload(upload, label) {
  if (!upload || typeof upload !== 'object') {
    throw new Error(`${label} must be an object.`);
  }

  const uploadFilePath = getUploadFilePath(upload, label);
  if (uploadFilePath) {
    const sizeBytes = Number(upload.size_bytes ?? upload.sizeBytes ?? 0);
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      throw new Error(`${label} must not be empty.`);
    }

    return {
      file_path: uploadFilePath,
      filename: getUploadFilename(upload, label),
      mime_type: getUploadMimeType(upload, label),
    };
  }

  if (upload.file != null) {
    const sizeBytes = Number(upload.size_bytes ?? upload.file.size ?? 0);
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      throw new Error(`${label} must not be empty.`);
    }

    return {
      file: upload.file,
      filename: getUploadFilename(upload, label),
      mime_type: getUploadMimeType(upload, label),
    };
  }

  if (upload.buffer != null) {
    const buffer = normalizeBinaryBuffer(upload.buffer, `${label}.buffer`);
    if (buffer.length === 0) {
      throw new Error(`${label} must not be empty.`);
    }

    return {
      buffer,
      filename: getUploadFilename(upload, label),
      mime_type: getUploadMimeType(upload, label),
    };
  }

  const uploadBase64Field = getUploadBase64Field(upload);
  if (uploadBase64Field == null) {
    throw new Error(`${label} must include base64 or data.`);
  }

  const buffer = Buffer.from(
    normalizeBase64UploadValue(uploadBase64Field.value, `${label}.${uploadBase64Field.field}`),
    'base64'
  );

  if (buffer.length === 0) {
    throw new Error(`${label} must not be empty.`);
  }

  const filename = getUploadFilename(upload, label);
  const mimeType = getUploadMimeType(upload, label);

  return {
    buffer,
    filename,
    mime_type: mimeType,
  };
}

function getUploadExtension(upload, fallbackExtension) {
  const fileExtension = path.extname(path.basename(upload.filename || '')).toLowerCase();
  if (fileExtension) {
    return fileExtension;
  }

  return MIME_TYPE_EXTENSIONS[upload.mime_type] || fallbackExtension;
}

function assertWavUpload(upload, label) {
  const filename = getUploadFilename(upload, label).toLowerCase();
  const mimeType = getUploadMimeType(upload, label).toLowerCase();

  if (WAV_MIME_TYPES.includes(mimeType) || path.extname(filename) === '.wav') {
    return;
  }

  throw new Error(`${label} must be an audio/wav upload.`);
}

async function writeBinaryUploadToTempFile(upload, tempDir, baseName, fallbackExtension) {
  const normalizedUpload = await normalizeBinaryUpload(upload, baseName);

  if (normalizedUpload.file_path != null) {
    return normalizedUpload.file_path;
  }

  const filePath = path.join(tempDir, `${baseName}${getUploadExtension(normalizedUpload, fallbackExtension)}`);

  if (normalizedUpload.file != null) {
    await pipeline(Readable.fromWeb(normalizedUpload.file.stream()), createWriteStream(filePath));
    return filePath;
  }

  await writeFile(filePath, normalizedUpload.buffer);
  return filePath;
}

function hasBinaryUploadSource(upload) {
  return upload?.buffer != null || upload?.file != null || upload?.file_path != null || upload?.filePath != null;
}

function hasDirectUploadFilePath(upload) {
  return getUploadFilePath(upload ?? {}, 'upload') !== '';
}

export function getGenerateClipDurationSeconds(requestBody) {
  return normalizePositiveNumber(
    requestBody.duration_seconds ?? requestBody.durationSeconds ?? requestBody.duration,
    5,
    'duration_seconds'
  );
}

export async function materializeGenerateClipBinaryInputs(requestBody, tempRoot = resolveManagedStorageRoot()) {
  const imageBinary = requestBody.image_binary ?? requestBody.imageBinary;
  const voiceoverBinary = requestBody.voiceover_binary ?? requestBody.voiceoverBinary;

  if (imageBinary == null && voiceoverBinary == null) {
    return null;
  }

  const needsTempDir = [imageBinary, voiceoverBinary]
    .some((upload) => upload != null && !hasDirectUploadFilePath(upload));
  const storageReservation = needsTempDir
    ? await reserveManagedStorageBytes({
      storageRoot: tempRoot,
      maxBytes: resolveManagedStorageMaxBytes(),
      bytes: [imageBinary, voiceoverBinary]
        .filter((upload) => upload != null && !hasDirectUploadFilePath(upload))
        .reduce((totalBytes, upload) => totalBytes + getUploadSizeBytes(upload), 0),
    })
    : null;
  const tempDir = needsTempDir
    ? await mkdtemp(path.join(tempRoot, GENERATE_CLIP_UPLOAD_DIR_PREFIX))
    : null;

  try {
    if (imageBinary != null && !hasBinaryUploadSource(imageBinary)) {
      throw new Error('image_binary must be sent as an n8n binary file upload.');
    }

    if (voiceoverBinary != null && !hasBinaryUploadSource(voiceoverBinary)) {
      throw new Error('voiceover_binary must be sent as an n8n binary file upload.');
    }

    return {
      temp_dir: tempDir,
      image_path: imageBinary == null
        ? null
        : await writeBinaryUploadToTempFile(imageBinary, tempDir, 'image-upload', '.png'),
      voiceover_path: voiceoverBinary == null
        ? null
        : await writeBinaryUploadToTempFile(voiceoverBinary, tempDir, 'voiceover-upload', '.wav'),
      cleanup: async () => {
        if (tempDir != null) {
          await rm(tempDir, { recursive: true, force: true });
        }
        storageReservation?.release();
      },
    };
  } catch (error) {
    if (tempDir != null) {
      await rm(tempDir, { recursive: true, force: true });
    }
    storageReservation?.release();
    throw error;
  }
}

export async function materializeProbeAudioBinaryInput(requestBody, tempRoot = resolveManagedStorageRoot()) {
  const audioBinary = requestBody.audio_binary ?? requestBody.audioBinary;

  if (audioBinary == null) {
    return null;
  }

  const storageReservation = hasDirectUploadFilePath(audioBinary)
    ? null
    : await reserveManagedStorageBytes({
      storageRoot: tempRoot,
      maxBytes: resolveManagedStorageMaxBytes(),
      bytes: getUploadSizeBytes(audioBinary),
    });
  const tempDir = hasDirectUploadFilePath(audioBinary)
    ? null
    : await mkdtemp(path.join(tempRoot, PROBE_AUDIO_UPLOAD_DIR_PREFIX));

  try {
    if (!hasBinaryUploadSource(audioBinary)) {
      throw new Error('audio_binary must be sent as an n8n binary file upload.');
    }

    assertWavUpload(audioBinary, 'audio_binary');

    return {
      temp_dir: tempDir,
      audio_path: await writeBinaryUploadToTempFile(audioBinary, tempDir, 'audio-upload', '.wav'),
      filename: getUploadFilename(audioBinary, 'audio_binary') || 'audio.wav',
      mime_type: getUploadMimeType(audioBinary, 'audio_binary') || 'audio/wav',
      cleanup: async () => {
        if (tempDir != null) {
          await rm(tempDir, { recursive: true, force: true });
        }
        storageReservation?.release();
      },
    };
  } catch (error) {
    if (tempDir != null) {
      await rm(tempDir, { recursive: true, force: true });
    }
    storageReservation?.release();
    throw error;
  }
}

export async function materializeJoinClipsInputs(requestBody, tempRoot = resolveManagedStorageRoot()) {
  if (!requestBody || typeof requestBody !== 'object') {
    throw new Error('The request body must be an object.');
  }

  if (!Array.isArray(requestBody.clips) || requestBody.clips.length === 0) {
    throw new Error('clips must be a non-empty array.');
  }

  const normalizedClipEntries = requestBody.clips.map((clip, index) => normalizeJoinClipsRequestEntry(clip, index));
  const backgroundMusicRequest = normalizeJoinClipsBackgroundMusicRequest(requestBody);
  const needsTempDir = normalizedClipEntries.some(
    (clip) => (
      (clip.clip_binary != null && !hasDirectUploadFilePath(clip.clip_binary))
      || (clip.subtitle_binary != null && !hasDirectUploadFilePath(clip.subtitle_binary))
    )
  );
  const storageReservation = needsTempDir
    ? await reserveManagedStorageBytes({
      storageRoot: tempRoot,
      maxBytes: resolveManagedStorageMaxBytes(),
      bytes: normalizedClipEntries.reduce((totalBytes, clip) => {
        let nextTotalBytes = totalBytes;

        if (clip.clip_binary != null && !hasDirectUploadFilePath(clip.clip_binary)) {
          nextTotalBytes += getUploadSizeBytes(clip.clip_binary);
        }

        if (clip.subtitle_binary != null && !hasDirectUploadFilePath(clip.subtitle_binary)) {
          nextTotalBytes += getUploadSizeBytes(clip.subtitle_binary);
        }

        return nextTotalBytes;
      }, 0),
    })
    : null;
  const tempDir = needsTempDir
    ? await mkdtemp(path.join(tempRoot, JOIN_CLIPS_UPLOAD_DIR_PREFIX))
    : null;

  try {
    normalizedClipEntries.forEach((clip, index) => {
      if (clip.clip_binary != null && !hasBinaryUploadSource(clip.clip_binary)) {
        throw new Error(`clips[${index}].clip_binary must be sent as an n8n binary file upload.`);
      }

      if (clip.subtitle_binary != null && !hasBinaryUploadSource(clip.subtitle_binary)) {
        throw new Error(`clips[${index}].subtitle_binary must be sent as an n8n binary file upload.`);
      }
    });

    return {
      temp_dir: tempDir,
      clips: await Promise.all(normalizedClipEntries.map(async (clip, index) => ({
        clip_path: clip.clip_binary == null
          ? resolveWorkspacePath(clip.clip_path, `clips[${index}].clip_path`)
          : await writeBinaryUploadToTempFile(clip.clip_binary, tempDir, `clip-${String(index + 1).padStart(2, '0')}`, '.mp4'),
        subtitle_path: clip.subtitle_binary == null
          ? (clip.subtitle_path == null ? null : resolveWorkspacePath(clip.subtitle_path, `clips[${index}].subtitle_path`))
          : await writeBinaryUploadToTempFile(clip.subtitle_binary, tempDir, `clip-${String(index + 1).padStart(2, '0')}-subtitle`, '.srt'),
        transition_to_next: clip.transition_to_next,
      }))),
      background_music_id: backgroundMusicRequest.background_music_id,
      background_music_path: backgroundMusicRequest.background_music_id == null
          ? null
          : resolveBundledBackgroundMusicPath(backgroundMusicRequest.background_music_id, 'background_music_id').path,
      cleanup: async () => {
        if (tempDir != null) {
          await rm(tempDir, { recursive: true, force: true });
        }
        storageReservation?.release();
      },
    };
  } catch (error) {
    if (tempDir != null) {
      await rm(tempDir, { recursive: true, force: true });
    }
    storageReservation?.release();
    throw error;
  }
}

export async function probeAudioDuration(requestBody) {
  if (!requestBody || typeof requestBody !== 'object') {
    throw new Error('The request body must be an object.');
  }

  logInfo('audio.probe.started', {
    filename: requestBody.audio_binary?.filename ?? requestBody.audio_binary?.fileName,
  });

  const materializedInput = await materializeProbeAudioBinaryInput(requestBody);

  try {
    if (materializedInput?.audio_path == null) {
      throw new Error('audio_binary is required.');
    }

    const durationSeconds = await probeClipDuration(materializedInput.audio_path);

    return {
      duration_seconds: Number(formatNumber(durationSeconds, 3)),
      filename: materializedInput.filename,
      mime_type: materializedInput.mime_type,
    };
  } finally {
    logInfo('audio.probe.completed', {
      filename: materializedInput?.filename,
    });
    await materializedInput?.cleanup?.();
  }
}

function normalizeGenerateClipAudio(requestBody, durationSeconds, materializedInputs) {
  const materializedVoiceoverPath = materializedInputs?.voiceover_path ?? null;
  const backgroundMusicId = requestBody.background_music_id ?? requestBody.backgroundMusicId;
  const materializedBackgroundMusicPath = backgroundMusicId == null
    ? null
    : resolveBundledBackgroundMusicPath(backgroundMusicId, 'background_music_id').path;
  const backgroundMusicMix = requestBody.background_music_mix ?? requestBody.backgroundMusicMix;

  if (backgroundMusicMix != null && materializedBackgroundMusicPath == null) {
    throw new Error('background_music_mix requires background_music_id.');
  }

  if (materializedVoiceoverPath == null && materializedBackgroundMusicPath == null) {
    return null;
  }

  return {
    voiceover_path: materializedVoiceoverPath,
    voiceover_mix: materializedVoiceoverPath == null
      ? null
      : normalizeVoiceoverMix(requestBody.voiceover_mix ?? requestBody.voiceoverMix, durationSeconds),
    background_music_path: materializedBackgroundMusicPath,
    background_music_mix: materializedBackgroundMusicPath == null
      ? null
      : normalizeBackgroundMusicMix(backgroundMusicMix, durationSeconds),
    audio_codec: normalizeAudioCodec(requestBody.audio_codec ?? requestBody.audioCodec),
    audio_bitrate: normalizeAudioBitrate(requestBody.audio_bitrate ?? requestBody.audioBitrate),
    audio_sample_rate: normalizeAudioSampleRate(requestBody.audio_sample_rate ?? requestBody.audioSampleRate),
  };
}

function buildPreparedAudioStreamFilter({
  inputIndex,
  audioSampleRate,
  durationSeconds,
  volume,
  fadeInSeconds = 0,
  fadeOutSeconds = 0,
  outputLabel,
}) {
  const filterParts = [
    `[${inputIndex}:a]aresample=${audioSampleRate}`,
    `aformat=sample_rates=${audioSampleRate}:channel_layouts=stereo`,
    `apad=whole_dur=${formatNumber(durationSeconds, 3)}`,
    `atrim=duration=${formatNumber(durationSeconds, 3)}`,
    'asetpts=PTS-STARTPTS',
  ];

  if (fadeInSeconds > 0) {
    filterParts.push(`afade=t=in:st=0:d=${formatNumber(fadeInSeconds, 3)}`);
  }

  filterParts.push(`volume=${formatNumber(volume, 3)}`);

  if (fadeOutSeconds > 0) {
    filterParts.push(
      `afade=t=out:st=${formatNumber(durationSeconds - fadeOutSeconds, 3)}:d=${formatNumber(fadeOutSeconds, 3)}`
    );
  }

  return `${filterParts.join(',')}[${outputLabel}]`;
}

function parseSrtTimestamp(value, label = 'subtitle timestamp') {
  const match = String(value).trim().match(/^(\d{2,}):(\d{2}):(\d{2}),(\d{3})$/);
  if (!match) {
    throw new Error(`${label} must use HH:MM:SS,mmm.`);
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number(match[4]);

  if (minutes >= 60 || seconds >= 60) {
    throw new Error(`${label} must use valid clock values.`);
  }

  return (((hours * 60) + minutes) * 60) + seconds + (milliseconds / 1000);
}

function formatSrtTimestamp(seconds) {
  const totalMilliseconds = Math.max(0, Math.round(Number(seconds) * 1000));
  const hours = Math.floor(totalMilliseconds / 3600000);
  const minutes = Math.floor((totalMilliseconds % 3600000) / 60000);
  const wholeSeconds = Math.floor((totalMilliseconds % 60000) / 1000);
  const milliseconds = totalMilliseconds % 1000;

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
}

function parseSrtCues(content, label) {
  const normalizedContent = String(content).replace(/\r\n/g, '\n').trim();
  if (normalizedContent.length === 0) {
    return [];
  }

  return normalizedContent.split(/\n{2,}/).map((block, index) => {
    const rawLines = block.split('\n').map((line) => line.trimEnd());
    const lines = rawLines[0] != null && /^\d+$/.test(rawLines[0].trim())
      ? rawLines.slice(1)
      : rawLines;
    const timeLine = lines[0];

    if (typeof timeLine !== 'string' || !timeLine.includes('-->')) {
      throw new Error(`${label} cue ${index + 1} is missing a valid time range.`);
    }

    const [rawStart, rawEnd] = timeLine.split('-->').map((value) => value.trim());
    const cueText = lines.slice(1).join('\n').trim();
    const startSeconds = parseSrtTimestamp(rawStart, `${label} cue ${index + 1} start`);
    const endSeconds = parseSrtTimestamp(rawEnd, `${label} cue ${index + 1} end`);

    if (cueText.length === 0) {
      throw new Error(`${label} cue ${index + 1} must contain subtitle text.`);
    }

    if (endSeconds <= startSeconds) {
      throw new Error(`${label} cue ${index + 1} must end after it starts.`);
    }

    return {
      start_seconds: startSeconds,
      end_seconds: endSeconds,
      text: cueText,
    };
  });
}

function stringifySrtCues(cues) {
  return cues.map((cue, index) => [
    String(index + 1),
    `${formatSrtTimestamp(cue.start_seconds)} --> ${formatSrtTimestamp(cue.end_seconds)}`,
    cue.text,
  ].join('\n')).join('\n\n');
}

function buildJoinSubtitleTimeline(clips, durations) {
  let currentOffsetSeconds = 0;

  return clips.map((clip, index) => {
    const segmentDurationSeconds = index === clips.length - 1
      ? durations[index]
      : durations[index] - clip.transition_to_next.duration_seconds;

    if (!Number.isFinite(segmentDurationSeconds) || segmentDurationSeconds <= 0) {
      throw new Error(`Subtitle segment ${index} must have a positive duration after transition trimming.`);
    }

    const timelineEntry = {
      clip_index: index,
      offset_seconds: Number(formatNumber(currentOffsetSeconds, 3)),
      segment_duration_seconds: Number(formatNumber(segmentDurationSeconds, 3)),
    };

    currentOffsetSeconds += segmentDurationSeconds;
    return timelineEntry;
  });
}

async function buildMergedJoinClipsSubtitleArtifact({ clips, durations, outputDir }) {
  const subtitleTimeline = buildJoinSubtitleTimeline(clips, durations);
  const cues = [];

  for (const timelineEntry of subtitleTimeline) {
    const clip = clips[timelineEntry.clip_index];
    if (clip.subtitle_path == null) {
      continue;
    }

    const clipSubtitleContent = await readFile(clip.subtitle_path, 'utf8');
    const clipCues = parseSrtCues(clipSubtitleContent, `clips[${timelineEntry.clip_index}].subtitle_path`);

    for (const cue of clipCues) {
      const trimmedStartSeconds = Math.max(cue.start_seconds, 0);
      const trimmedEndSeconds = Math.min(cue.end_seconds, timelineEntry.segment_duration_seconds);

      if (trimmedEndSeconds <= trimmedStartSeconds) {
        continue;
      }

      cues.push({
        start_seconds: Number(formatNumber(timelineEntry.offset_seconds + trimmedStartSeconds, 3)),
        end_seconds: Number(formatNumber(timelineEntry.offset_seconds + trimmedEndSeconds, 3)),
        text: cue.text,
      });
    }
  }

  if (cues.length === 0) {
    return null;
  }

  const outputPath = path.join(outputDir, 'join-clips.srt');
  await writeFile(outputPath, `${stringifySrtCues(cues)}\n`, 'utf8');

  return {
    artifact_id: 'subtitle_srt',
    kind: 'subtitle_track',
    format: 'srt',
    file_path: outputPath,
    filename: path.basename(outputPath),
    content_type: SRT_CONTENT_TYPE,
    cue_count: cues.length,
  };
}

function buildGenerateClipAudioFilterGraph({
  audio,
  durationSeconds,
  voiceoverInputIndex,
  backgroundMusicInputIndex,
}) {
  if (audio == null) {
    return null;
  }

  const filterParts = [];
  const hasVoiceover = voiceoverInputIndex != null;
  const hasBackgroundMusic = backgroundMusicInputIndex != null;

  if (hasVoiceover) {
    filterParts.push(buildPreparedAudioStreamFilter({
      inputIndex: voiceoverInputIndex,
      audioSampleRate: audio.audio_sample_rate,
      durationSeconds,
      volume: audio.voiceover_mix.volume,
      fadeOutSeconds: audio.voiceover_mix.fade_out_seconds,
      outputLabel: hasBackgroundMusic ? 'avoice' : 'aout',
    }));
  }

  if (hasBackgroundMusic) {
    filterParts.push(buildPreparedAudioStreamFilter({
      inputIndex: backgroundMusicInputIndex,
      audioSampleRate: audio.audio_sample_rate,
      durationSeconds,
      volume: audio.background_music_mix.volume,
      fadeInSeconds: audio.background_music_mix.fade_in_seconds,
      fadeOutSeconds: audio.background_music_mix.fade_out_seconds,
      outputLabel: hasVoiceover ? 'abg' : 'aout',
    }));
  }

  if (hasVoiceover && hasBackgroundMusic) {
    let musicLabel = 'abg';
    let mixVoiceLabel = 'avoice';

    if (audio.background_music_mix.ducking_enabled) {
      filterParts.push('[avoice]asplit=2[avoiceduck][avoicemix]');
      filterParts.push(
        `[abg][avoiceduck]sidechaincompress=threshold=${formatNumber(DEFAULT_BACKGROUND_MUSIC_DUCKING_THRESHOLD, 3)}:ratio=${formatNumber(DEFAULT_BACKGROUND_MUSIC_DUCKING_RATIO, 3)}:attack=${DEFAULT_BACKGROUND_MUSIC_DUCKING_ATTACK_MS}:release=${DEFAULT_BACKGROUND_MUSIC_DUCKING_RELEASE_MS}[abgduck]`
      );
      musicLabel = 'abgduck';
      mixVoiceLabel = 'avoicemix';
    }

    filterParts.push(
      `[${musicLabel}][${mixVoiceLabel}]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`
    );
  }

  if (filterParts.length === 0) {
    return null;
  }

  return {
    filterGraph: filterParts.join(';'),
    outputLabel: 'aout',
  };
}

export function buildGenerateClipFfmpegArgs({
  imagePath,
  outputPath,
  filterGraph,
  videoOutputLabel = 'vout',
  durationSeconds,
  fps,
  videoCodec,
  encodePreset,
  crf,
  audio,
}) {
  const args = [
    '-y',
    '-i',
    imagePath,
  ];

  let voiceoverInputIndex = null;
  let backgroundMusicInputIndex = null;

  if (audio?.voiceover_path) {
    voiceoverInputIndex = 1;
    args.push(
      '-i',
      audio.voiceover_path,
    );
  }

  if (audio?.background_music_path) {
    backgroundMusicInputIndex = voiceoverInputIndex == null ? 1 : 2;
    if (audio.background_music_mix.loop) {
      args.push('-stream_loop', '-1');
    }
    args.push(
      '-i',
      audio.background_music_path,
    );
  }

  const audioFilterGraph = buildGenerateClipAudioFilterGraph({
    audio,
    durationSeconds,
    voiceoverInputIndex,
    backgroundMusicInputIndex,
  });
  const combinedFilterGraph = audioFilterGraph == null
    ? filterGraph
    : `${filterGraph};${audioFilterGraph.filterGraph}`;

  args.push(
    '-filter_complex',
    combinedFilterGraph,
    '-map',
    `[${videoOutputLabel}]`
  );

  if (audioFilterGraph != null) {
    args.push(
      '-map',
      `[${audioFilterGraph.outputLabel}]`,
      '-c:a',
      audio.audio_codec,
      '-b:a',
      audio.audio_bitrate,
      '-ar',
      String(audio.audio_sample_rate),
      '-shortest'
    );
  } else {
    args.push('-an');
  }

  args.push(
    '-c:v',
    videoCodec,
    '-preset',
    encodePreset,
    '-crf',
    String(crf),
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    outputPath,
  );

  return args;
}

export function buildGenerateClipVideoFilterGraph({ filterGraph, subtitles = null }) {
  if (subtitles == null) {
    return {
      filterGraph,
      videoOutputLabel: 'vout',
    };
  }

  const subtitleDelivery = subtitles.delivery == null
    ? DEFAULT_SUBTITLE_DELIVERY
    : normalizeSubtitleDelivery(subtitles.delivery);

  if (subtitleDelivery === 'external') {
    return {
      filterGraph,
      videoOutputLabel: 'vout',
    };
  }

  if (typeof subtitles !== 'object' || subtitles.subtitle_path == null) {
    throw new Error('subtitles.subtitle_path is required when burning subtitles.');
  }

  const subtitleOptions = [
    `subtitles='${escapeFilterLiteral(subtitles.subtitle_path)}'`,
  ];

  if (subtitles.force_style != null) {
    subtitleOptions.push(`force_style='${escapeFilterOptionValue(subtitles.force_style)}'`);
  }

  return {
    filterGraph: `${filterGraph};[vout]${subtitleOptions.join(':')}[vsub]`,
    videoOutputLabel: 'vsub',
  };
}

export function buildJoinClipsFfmpegArgs({
  clips,
  filterGraph,
  outputLabel,
  outputPath,
  videoCodec,
  encodePreset,
  crf,
  audio = null,
}) {
  const args = [
    '-y',
    ...clips.flatMap((clip) => ['-i', clip.clip_path]),
  ];

  if (audio?.background_music_path) {
    if (audio.background_music_mix?.loop) {
      args.push('-stream_loop', '-1');
    }

    args.push('-i', audio.background_music_path);
  }

  args.push(
    '-filter_complex',
    filterGraph,
    '-map',
    `[${outputLabel}]`,
  );

  if (audio) {
    args.push(
      '-map',
      `[${audio.outputLabel}]`,
      '-c:a',
      audio.audio_codec,
      '-b:a',
      audio.audio_bitrate,
      '-ar',
      String(audio.audio_sample_rate),
      '-shortest'
    );
  } else {
    args.push('-an');
  }

  args.push(
    '-c:v',
    videoCodec,
    '-preset',
    encodePreset,
    '-crf',
    String(crf),
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    outputPath,
  );

  return args;
}

export async function generateClip(requestBody) {
  if (!requestBody || typeof requestBody !== 'object') {
    throw new Error('The request body must be an object.');
  }

  const materializedInputs = await materializeGenerateClipBinaryInputs(requestBody);
  let outputDir = null;
  let shouldCleanupOutputDir = false;

  try {
    if (materializedInputs?.image_path == null) {
      throw new Error('image_binary is required.');
    }

    const imagePath = materializedInputs.image_path;
    outputDir = await mkdtemp(path.join(resolveManagedStorageRoot(), GENERATE_CLIP_UPLOAD_DIR_PREFIX));
    shouldCleanupOutputDir = true;
    const outputPath = path.join(outputDir, 'generate-clip.mp4');
    const overlayText = normalizeNullableString(requestBody.overlay_text ?? requestBody.overlayText, 'overlay_text');
    const durationSeconds = getGenerateClipDurationSeconds(requestBody);
    const width = normalizePositiveInteger(requestBody.width, DEFAULT_WIDTH, 'width');
    const height = normalizePositiveInteger(requestBody.height, DEFAULT_HEIGHT, 'height');
    const fps = normalizePositiveInteger(requestBody.fps, DEFAULT_FPS, 'fps');
    const fontSize = normalizePositiveInteger(requestBody.font_size ?? requestBody.fontSize, DEFAULT_FONT_SIZE, 'font_size');
    const fontColor = normalizeOptionalString(requestBody.font_color ?? requestBody.fontColor, DEFAULT_FONT_COLOR);
    const borderColor = normalizeOptionalString(requestBody.border_color ?? requestBody.borderColor, DEFAULT_BORDER_COLOR);
    const fontFile = normalizeOptionalString(requestBody.font_file ?? requestBody.fontFile, process.env.FONT_FILE || '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf');
    const sceneAnimation = validateSceneAnimation(requestBody.scene_animation ?? requestBody.sceneAnimation);
    const videoCodec = normalizeCodec(requestBody.video_codec ?? requestBody.videoCodec);
    const encodePreset = getAdaptiveEncodePreset(requestBody.encode_preset ?? requestBody.encodePreset, durationSeconds);
    const crf = normalizeCrf(requestBody.crf);
    const audio = normalizeGenerateClipAudio(requestBody, durationSeconds, materializedInputs);
    const subtitleRequest = normalizeGenerateClipSubtitleRequest(requestBody, audio);
    const baseFilterGraph = buildImageTextSceneFilterGraph({
      sceneAnimation,
      overlayText,
      width,
      height,
      fps,
      durationSeconds,
      fontFile,
      fontSize,
      fontColor,
      borderColor,
    });
    const subtitleTrack = subtitleRequest == null
      ? null
      : await createAlignedSubtitleTrack({
        audioPath: audio.voiceover_path,
        audioText: subtitleRequest.audio_text,
        audioLanguage: subtitleRequest.audio_language,
        subtitleTheme: subtitleRequest.subtitle_theme,
        subtitleDelivery: subtitleRequest.subtitle_delivery,
        highlightWords: subtitleRequest.highlight_words,
        width,
        height,
        outputDir,
      });
    const { filterGraph, videoOutputLabel } = buildGenerateClipVideoFilterGraph({
      filterGraph: baseFilterGraph,
      subtitles: subtitleTrack,
    });

    logInfo('render.generate_clip.started', {
      duration_seconds: Number(formatNumber(durationSeconds, 3)),
      width,
      height,
      fps,
      has_voiceover: audio?.voiceover_path != null,
      has_background_music: audio?.background_music_path != null,
      has_subtitles: subtitleTrack != null,
      subtitle_language: subtitleTrack?.subtitle_language,
      subtitle_theme: subtitleTrack?.subtitle_theme,
      subtitle_delivery: subtitleTrack?.delivery,
      subtitle_highlight_words: subtitleTrack?.highlight_words,
      scene_animation: {
        image_motion_preset: sceneAnimation.image_motion_preset,
        text_motion_preset: sceneAnimation.text_motion_preset,
        speed: sceneAnimation.speed,
        text_anchor: sceneAnimation.text_anchor,
      },
    });

    await mkdir(path.dirname(outputPath), { recursive: true });

    await runCommand('ffmpeg', buildGenerateClipFfmpegArgs({
      imagePath,
      outputPath,
      filterGraph,
      videoOutputLabel,
      durationSeconds,
      fps,
      videoCodec,
      encodePreset,
      crf,
      audio,
    }));

    const outputStats = await stat(outputPath);

    logInfo('render.generate_clip.completed', {
      duration_seconds: Number(formatNumber(durationSeconds, 3)),
      width,
      height,
      fps,
      has_voiceover: audio?.voiceover_path != null,
      has_background_music: audio?.background_music_path != null,
      has_subtitles: subtitleTrack != null,
      subtitle_theme: subtitleTrack?.subtitle_theme,
      subtitle_delivery: subtitleTrack?.delivery,
      subtitle_highlight_words: subtitleTrack?.highlight_words,
      output_filename: 'generate-clip.mp4',
      output_size_bytes: outputStats.size,
    });

    const subtitleArtifacts = subtitleTrack?.delivery === 'external'
      ? [
          {
            artifact_id: 'subtitle_srt',
            kind: 'subtitle_track',
            format: 'srt',
            file_path: subtitleTrack.subtitle_path,
            filename: path.basename(subtitleTrack.subtitle_path),
            content_type: subtitleTrack.subtitle_content_type,
          },
        ]
      : undefined;

    shouldCleanupOutputDir = false;
    return {
      file_path: outputPath,
      temp_dir: outputDir,
      content_type: 'video/mp4',
      filename: 'generate-clip.mp4',
      duration_seconds: Number(formatNumber(durationSeconds, 3)),
      width,
      height,
      fps,
      has_voiceover: audio?.voiceover_path != null,
      has_background_music: audio?.background_music_path != null,
      has_subtitles: subtitleTrack != null,
      subtitle_theme: subtitleTrack?.subtitle_theme ?? DEFAULT_SUBTITLE_THEME,
      subtitle_delivery: subtitleTrack?.delivery ?? DEFAULT_SUBTITLE_DELIVERY,
      subtitle_highlight_words: subtitleTrack?.highlight_words ?? false,
      ...(subtitleArtifacts == null ? {} : { artifacts: subtitleArtifacts }),
      scene_animation: sceneAnimation,
    };
  } finally {
    await materializedInputs?.cleanup?.();
    if (shouldCleanupOutputDir && outputDir != null) {
      await rm(outputDir, { recursive: true, force: true });
    }
  }
}

export async function joinVideoClips(requestBody) {
  if (!requestBody || typeof requestBody !== 'object') {
    throw new Error('The request body must be an object.');
  }

  const materializedInputs = await materializeJoinClipsInputs(requestBody);
  let outputDir = null;
  let shouldCleanupOutputDir = false;

  try {
    outputDir = await mkdtemp(path.join(resolveManagedStorageRoot(), JOIN_CLIPS_UPLOAD_DIR_PREFIX));
    shouldCleanupOutputDir = true;
    const clips = materializedInputs.clips;
    const outputPath = path.join(outputDir, 'join-clips.mp4');
    const width = normalizePositiveInteger(requestBody.width, DEFAULT_WIDTH, 'width');
    const height = normalizePositiveInteger(requestBody.height, DEFAULT_HEIGHT, 'height');
    const fps = normalizePositiveInteger(requestBody.fps, DEFAULT_FPS, 'fps');
    const videoCodec = normalizeCodec(requestBody.video_codec ?? requestBody.videoCodec);
    const crf = normalizeCrf(requestBody.crf);

    logInfo('compose.join_clips.started', {
      clip_count: clips.length,
      width,
      height,
      fps,
    });

    const clipStreamInfos = await Promise.all(clips.map((clip) => probeClipStreamInfo(clip.clip_path)));
    const durations = clipStreamInfos.map((clipInfo) => clipInfo.video_duration_seconds);
    const { filterGraph, outputLabel, totalDurationSeconds } = buildJoinClipsFilterGraph({
      clips,
      durations,
      width,
      height,
      fps,
    });
    const mergedSubtitleArtifact = await buildMergedJoinClipsSubtitleArtifact({
      clips,
      durations,
      outputDir,
    });
    const hasAudio = clipStreamInfos.some((clipInfo) => clipInfo.has_audio);
    const backgroundMusicMixRequest = requestBody.background_music_mix ?? requestBody.backgroundMusicMix;

    if (backgroundMusicMixRequest != null && materializedInputs.background_music_path == null) {
      throw new Error('background_music_mix requires background_music_id.');
    }

    const backgroundMusic = materializedInputs.background_music_path == null
      ? null
      : {
        path: materializedInputs.background_music_path,
        mix: normalizeBackgroundMusicMix(
          backgroundMusicMixRequest,
          totalDurationSeconds,
        ),
      };
    const audioGraph = hasAudio || backgroundMusic != null
      ? buildJoinClipsAudioFilterGraph({
        clips,
        durations,
        audioTracks: clipStreamInfos.map((clipInfo) => clipInfo.has_audio),
        backgroundMusic,
      })
      : null;

    logInfo('compose.join_clips.audio_plan', {
      clip_count: clips.length,
      video_durations_seconds: durations.map((duration) => Number(formatNumber(duration, 3))),
      audio_tracks: clipStreamInfos.map((clipInfo) => clipInfo.has_audio),
      has_audio: hasAudio,
      has_background_music: backgroundMusic != null,
    });

    const encodePreset = getAdaptiveEncodePreset(requestBody.encode_preset ?? requestBody.encodePreset, totalDurationSeconds);

    await mkdir(path.dirname(outputPath), { recursive: true });

    await runCommand('ffmpeg', buildJoinClipsFfmpegArgs({
      clips,
      filterGraph: audioGraph == null ? filterGraph : `${filterGraph};${audioGraph.filterGraph}`,
      outputLabel,
      outputPath,
      videoCodec,
      encodePreset,
      crf,
      audio: audioGraph == null ? null : {
        outputLabel: audioGraph.outputLabel,
        audio_codec: DEFAULT_AUDIO_CODEC,
        audio_bitrate: DEFAULT_AUDIO_BITRATE,
        audio_sample_rate: DEFAULT_AUDIO_SAMPLE_RATE,
        background_music_path: backgroundMusic?.path,
        background_music_mix: backgroundMusic?.mix,
      },
    }));

    const outputStats = await stat(outputPath);

    logInfo('compose.join_clips.completed', {
      clip_count: clips.length,
      total_duration_seconds: totalDurationSeconds,
      width,
      height,
      fps,
      has_audio: hasAudio,
      has_background_music: backgroundMusic != null,
      has_subtitles: mergedSubtitleArtifact != null,
      output_filename: 'join-clips.mp4',
      output_size_bytes: outputStats.size,
    });

    shouldCleanupOutputDir = false;
    return {
      file_path: outputPath,
      temp_dir: outputDir,
      content_type: 'video/mp4',
      filename: 'join-clips.mp4',
      total_duration_seconds: totalDurationSeconds,
      width,
      height,
      fps,
      has_audio: hasAudio,
      has_background_music: backgroundMusic != null,
      has_subtitles: mergedSubtitleArtifact != null,
      ...(mergedSubtitleArtifact == null ? {} : { artifacts: [mergedSubtitleArtifact] }),
      clips: clips.map((clip) => ({
        clip_path: clip.clip_path,
        ...(clip.subtitle_path == null ? {} : { subtitle_path: clip.subtitle_path }),
        transition_to_next: clip.transition_to_next,
      })),
    };
  } finally {
    await materializedInputs.cleanup();
    if (shouldCleanupOutputDir && outputDir != null) {
      await rm(outputDir, { recursive: true, force: true });
    }
  }
}

export async function getHealthStatus() {
  const [ffmpeg, ffprobe] = await Promise.all([
    runCommand('ffmpeg', ['-version']),
    runCommand('ffprobe', ['-version']),
  ]);

  return {
    ok: true,
    workspace_root: getWorkspaceRoot(),
    ffmpeg: ffmpeg.stdout.split('\n')[0].trim(),
    ffprobe: ffprobe.stdout.split('\n')[0].trim(),
  };
}

export function getPresetCatalog() {
  return {
    scene_animation: {
      image_motion_preset: {
        static_hold: 'Plano casi fijo con microrespiracion visual.',
        slow_push_in: 'Acercamiento suave para hooks, impacto o cierre.',
        slow_pull_out: 'Apertura suave para contexto, CTA o cierre reflexivo.',
        pan_left_slow: 'Barrido lateral sobrio para charts, stock o procesos.',
        pan_right_slow: 'Barrido lateral inverso para continuidad o contraste.',
        drift_up_soft: 'Desplazamiento vertical ascendente, util en hogares, plantas o procesos.',
        drift_down_soft: 'Desplazamiento vertical descendente para remates o contrapuntos.',
        parallax_float: 'Flotacion ligera para diagramas o composiciones hibridas.',
      },
      text_motion_preset: {
        fade_in_hold: 'Entrada limpia y estable del texto.',
        fade_up_soft: 'Texto asciende de forma leve mientras aparece.',
        slide_left_soft: 'Texto entra desde la derecha con poca inercia.',
        slide_right_soft: 'Texto entra desde la izquierda con poca inercia.',
        type_on_soft: 'Revelado escalonado del texto para piezas didacticas.',
      },
      speed: SCENE_ANIMATION_SPEEDS,
      text_anchor: SCENE_TEXT_ANCHORS,
    },
    transition_to_next: {
      presets: {
        none: 'Corte seco.',
        fade: 'Fundido cruzado sobrio.',
        wipe_left: 'Barrido hacia la izquierda.',
        wipe_right: 'Barrido hacia la derecha.',
        wipe_up: 'Barrido ascendente.',
        wipe_down: 'Barrido descendente.',
        slide_left: 'Deslizamiento horizontal hacia la izquierda.',
        slide_right: 'Deslizamiento horizontal hacia la derecha.',
        zoom_in: 'Paso con ligera aproximacion.',
      },
      max_duration_seconds: 1.2,
    },
    background_music: {
      id_format: '<filename>',
      legacy_id_format_accepted: LEGACY_BACKGROUND_MUSIC_ID_FORMAT,
      tracks: buildBundledBackgroundMusicCatalog(),
    },
  };
}
