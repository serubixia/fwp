import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { logError, logInfo } from './logger.mjs';

export const SCENE_IMAGE_MOTION_PRESETS = Object.freeze([
  'static_hold',
  'slow_push_in',
  'slow_pull_out',
  'pan_left_slow',
  'pan_right_slow',
  'drift_up_soft',
  'drift_down_soft',
  'parallax_float',
]);

export const SCENE_TEXT_MOTION_PRESETS = Object.freeze([
  'fade_in_hold',
  'fade_up_soft',
  'slide_left_soft',
  'slide_right_soft',
  'type_on_soft',
]);

export const SCENE_ANIMATION_SPEEDS = Object.freeze(['slow', 'medium']);
export const SCENE_TEXT_ANCHORS = Object.freeze(['upper_third', 'center', 'lower_third']);
export const SCENE_TRANSITION_PRESETS = Object.freeze([
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
const DEFAULT_FONT_SIZE = 72;
const DEFAULT_FONT_COLOR = 'white';
const DEFAULT_BORDER_COLOR = 'black@0.45';
const GENERATE_CLIP_UPLOAD_DIR_PREFIX = 'ffmpeg-api-generate-clip-';
const JOIN_CLIPS_UPLOAD_DIR_PREFIX = 'ffmpeg-api-join-clips-';
const PROBE_AUDIO_UPLOAD_DIR_PREFIX = 'ffmpeg-api-probe-audio-';
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

function escapeExpression(value) {
  return String(value).replace(/,/g, '\\,');
}

async function runCommand(binary, args) {
  const startedAt = Date.now();
  const commandPreview = `${binary} ${args.join(' ')}`;

  logInfo('process.command.started', {
    binary,
    command: commandPreview.length > 1200 ? `${commandPreview.slice(0, 1197)}...` : commandPreview,
  });

  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      logError('process.command.spawn_failed', {
        binary,
        duration_ms: Date.now() - startedAt,
        error: error.message,
      });
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        logInfo('process.command.completed', {
          binary,
          duration_ms: Date.now() - startedAt,
          stdout_bytes: Buffer.byteLength(stdout),
          stderr_bytes: Buffer.byteLength(stderr),
        });
        resolve({ stdout, stderr });
        return;
      }

      logError('process.command.failed', {
        binary,
        duration_ms: Date.now() - startedAt,
        exit_code: code,
        stderr_excerpt: stderr.trim().length > 1200 ? `...${stderr.trim().slice(-1197)}` : stderr.trim() || undefined,
        stdout_excerpt: stdout.trim().length > 1200 ? `...${stdout.trim().slice(-1197)}` : stdout.trim() || undefined,
      });

      reject(new Error([
        `${binary} exited with code ${code}.`,
        stderr.trim(),
        stdout.trim(),
      ].filter(Boolean).join('\n')));
    });
  });
}

export function getWorkspaceRoot() {
  return path.resolve(process.env.WORKSPACE_ROOT || '/workspace');
}

export function resolveWorkspacePath(inputPath, label) {
  const rawPath = ensureNonEmptyString(inputPath, label);
  const workspaceRoot = getWorkspaceRoot();
  const resolvedPath = path.resolve(workspaceRoot, rawPath);
  const relativePath = path.relative(workspaceRoot, resolvedPath);

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`${label} must stay inside WORKSPACE_ROOT (${workspaceRoot}).`);
  }

  return resolvedPath;
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

function buildProgressExpressions(totalFrames) {
  const lastFrameIndex = Math.max(totalFrames - 1, 1);
  const progress = `on/${lastFrameIndex}`;

  return {
    progress,
    easedProgress: buildSmootherStepExpression(progress),
  };
}

function getDurationAwareZoomDelta(durationSeconds, {
  minDelta,
  maxDelta,
  deltaPerSecond,
}) {
  return clampNumber(durationSeconds * deltaPerSecond, minDelta, maxDelta);
}

const TRAVEL_MOTION_FAMILY_CONFIG = Object.freeze({
  pan: Object.freeze({
    zoomDelta: Object.freeze({
      slow: Object.freeze({ minDelta: 0.028, maxDelta: 0.048, deltaPerSecond: 0.0008 }),
      medium: Object.freeze({ minDelta: 0.04, maxDelta: 0.072, deltaPerSecond: 0.0011 }),
    }),
    travel: Object.freeze({
      slow: Object.freeze({ pixelsPerSecond: 0.4, minTravelPixels: 6, maxTravelRatio: 0.32 }),
      medium: Object.freeze({ pixelsPerSecond: 0.65, minTravelPixels: 10, maxTravelRatio: 0.42 }),
    }),
  }),
  drift: Object.freeze({
    zoomDelta: Object.freeze({
      slow: Object.freeze({ minDelta: 0.024, maxDelta: 0.042, deltaPerSecond: 0.0007 }),
      medium: Object.freeze({ minDelta: 0.036, maxDelta: 0.06, deltaPerSecond: 0.00095 }),
    }),
    travel: Object.freeze({
      slow: Object.freeze({ pixelsPerSecond: 0.22, minTravelPixels: 4, maxTravelRatio: 0.2 }),
      medium: Object.freeze({ pixelsPerSecond: 0.34, minTravelPixels: 6, maxTravelRatio: 0.28 }),
    }),
  }),
  parallax: Object.freeze({
    zoomDelta: Object.freeze({
      slow: Object.freeze({ minDelta: 0.04, maxDelta: 0.065, deltaPerSecond: 0.0009 }),
      medium: Object.freeze({ minDelta: 0.055, maxDelta: 0.085, deltaPerSecond: 0.00115 }),
    }),
    horizontalTravel: Object.freeze({
      slow: Object.freeze({ pixelsPerSecond: 0.28, minTravelPixels: 8, maxTravelRatio: 0.22 }),
      medium: Object.freeze({ pixelsPerSecond: 0.42, minTravelPixels: 10, maxTravelRatio: 0.28 }),
    }),
    verticalAmplitude: Object.freeze({
      slow: Object.freeze({ pixelsPerSecond: 0.14, minAmplitudeRatio: 0.03, maxAmplitudeRatio: 0.07 }),
      medium: Object.freeze({ pixelsPerSecond: 0.2, minAmplitudeRatio: 0.04, maxAmplitudeRatio: 0.1 }),
    }),
  }),
});

function getDurationAwareTravelFamilyZoomLevel(durationSeconds, familyName, speed) {
  const familyConfig = TRAVEL_MOTION_FAMILY_CONFIG[familyName];
  const zoomConfig = familyConfig?.zoomDelta?.[speed];

  if (!zoomConfig) {
    throw new Error(`Unsupported travel motion family: ${familyName}.${speed}`);
  }

  return 1 + getDurationAwareZoomDelta(durationSeconds, zoomConfig);
}

function buildDurationAwareTravelFamilyBudget({
  durationSeconds,
  sourceSize,
  zoomLevel,
  familyName,
  speed,
}) {
  const familyConfig = TRAVEL_MOTION_FAMILY_CONFIG[familyName];
  const travelConfig = familyConfig?.travel?.[speed] ?? familyConfig?.horizontalTravel?.[speed];

  if (!travelConfig) {
    throw new Error(`Unsupported travel budget family: ${familyName}.${speed}`);
  }

  return buildDurationAwareTravelBudget({
    durationSeconds,
    sourceSize,
    zoomLevel,
    pixelsPerSecond: travelConfig.pixelsPerSecond,
    minTravelPixels: travelConfig.minTravelPixels,
    maxTravelRatio: travelConfig.maxTravelRatio,
  });
}

function buildDurationAwareTravelBudget({
  durationSeconds,
  sourceSize,
  zoomLevel,
  pixelsPerSecond,
  minTravelPixels,
  maxTravelRatio,
}) {
  const availableTravelPixels = Math.max(sourceSize - (sourceSize / zoomLevel), 1);
  const desiredTravelPixels = clampNumber(
    durationSeconds * pixelsPerSecond,
    minTravelPixels,
    availableTravelPixels * maxTravelRatio
  );
  const travelRatio = desiredTravelPixels / availableTravelPixels;
  const startRatio = 0.5 - (travelRatio / 2);

  return {
    startRatio: formatNumber(startRatio, 3),
    endRatio: formatNumber(startRatio + travelRatio, 3),
    travelRatio: formatNumber(travelRatio, 3),
  };
}

function buildImageMotionExpressions(sceneAnimation, {
  durationSeconds,
  totalFrames,
  sourceWidth,
  sourceHeight,
}) {
  const { progress, easedProgress } = buildProgressExpressions(totalFrames);

  switch (sceneAnimation.image_motion_preset) {
    case 'static_hold':
      return {
        z: '1.015',
        x: 'iw/2-(iw/zoom/2)',
        y: 'ih/2-(ih/zoom/2)',
      };
    case 'slow_push_in': {
      const zoomDelta = sceneAnimation.speed === 'slow'
        ? getDurationAwareZoomDelta(durationSeconds, {
          minDelta: 0.018,
          maxDelta: 0.06,
          deltaPerSecond: 0.0011,
        })
        : getDurationAwareZoomDelta(durationSeconds, {
          minDelta: 0.028,
          maxDelta: 0.09,
          deltaPerSecond: 0.00145,
        });

      return {
        z: `1+${formatNumber(zoomDelta, 3)}*${easedProgress}`,
        x: 'iw/2-(iw/zoom/2)',
        y: 'ih/2-(ih/zoom/2)',
      };
    }
    case 'slow_pull_out': {
      const zoomDelta = sceneAnimation.speed === 'slow'
        ? getDurationAwareZoomDelta(durationSeconds, {
          minDelta: 0.02,
          maxDelta: 0.065,
          deltaPerSecond: 0.0012,
        })
        : getDurationAwareZoomDelta(durationSeconds, {
          minDelta: 0.032,
          maxDelta: 0.095,
          deltaPerSecond: 0.00155,
        });
      const initialZoom = 1 + zoomDelta;

      return {
        z: `${formatNumber(initialZoom, 3)}-${formatNumber(zoomDelta, 3)}*${easedProgress}`,
        x: 'iw/2-(iw/zoom/2)',
        y: 'ih/2-(ih/zoom/2)',
      };
    }
    case 'pan_left_slow': {
      const zoomLevel = getDurationAwareTravelFamilyZoomLevel(durationSeconds, 'pan', sceneAnimation.speed);
      const travelBudget = buildDurationAwareTravelFamilyBudget({
        durationSeconds,
        sourceSize: sourceWidth,
        zoomLevel,
        familyName: 'pan',
        speed: sceneAnimation.speed,
      });

      return {
        z: formatNumber(zoomLevel, 3),
        x: `(iw-iw/zoom)*(${travelBudget.startRatio}+${travelBudget.travelRatio}*${easedProgress})`,
        y: 'ih/2-(ih/zoom/2)',
      };
    }
    case 'pan_right_slow': {
      const zoomLevel = getDurationAwareTravelFamilyZoomLevel(durationSeconds, 'pan', sceneAnimation.speed);
      const travelBudget = buildDurationAwareTravelFamilyBudget({
        durationSeconds,
        sourceSize: sourceWidth,
        zoomLevel,
        familyName: 'pan',
        speed: sceneAnimation.speed,
      });

      return {
        z: formatNumber(zoomLevel, 3),
        x: `(iw-iw/zoom)*(${travelBudget.endRatio}-${travelBudget.travelRatio}*${easedProgress})`,
        y: 'ih/2-(ih/zoom/2)',
      };
    }
    case 'drift_up_soft': {
      const zoomLevel = getDurationAwareTravelFamilyZoomLevel(durationSeconds, 'drift', sceneAnimation.speed);
      const travelBudget = buildDurationAwareTravelFamilyBudget({
        durationSeconds,
        sourceSize: sourceHeight,
        zoomLevel,
        familyName: 'drift',
        speed: sceneAnimation.speed,
      });

      return {
        z: formatNumber(zoomLevel, 3),
        x: 'iw/2-(iw/zoom/2)',
        y: `(ih-ih/zoom)*(${travelBudget.endRatio}-${travelBudget.travelRatio}*${easedProgress})`,
      };
    }
    case 'drift_down_soft': {
      const zoomLevel = getDurationAwareTravelFamilyZoomLevel(durationSeconds, 'drift', sceneAnimation.speed);
      const travelBudget = buildDurationAwareTravelFamilyBudget({
        durationSeconds,
        sourceSize: sourceHeight,
        zoomLevel,
        familyName: 'drift',
        speed: sceneAnimation.speed,
      });

      return {
        z: formatNumber(zoomLevel, 3),
        x: 'iw/2-(iw/zoom/2)',
        y: `(ih-ih/zoom)*(${travelBudget.startRatio}+${travelBudget.travelRatio}*${easedProgress})`,
      };
    }
    case 'parallax_float': {
      const zoomLevel = getDurationAwareTravelFamilyZoomLevel(durationSeconds, 'parallax', sceneAnimation.speed);
      const horizontalBudget = buildDurationAwareTravelFamilyBudget({
        durationSeconds,
        sourceSize: sourceWidth,
        zoomLevel,
        familyName: 'parallax',
        speed: sceneAnimation.speed,
      });
      const verticalAmplitudeConfig = TRAVEL_MOTION_FAMILY_CONFIG.parallax.verticalAmplitude[sceneAnimation.speed];
      const verticalSlack = Math.max(sourceHeight - (sourceHeight / zoomLevel), 1);
      const verticalAmplitudeRatio = clampNumber(
        (durationSeconds * verticalAmplitudeConfig.pixelsPerSecond) / verticalSlack,
        verticalAmplitudeConfig.minAmplitudeRatio,
        verticalAmplitudeConfig.maxAmplitudeRatio
      );
      const verticalFloatEnvelope = `(4*${easedProgress}*(1-${easedProgress}))`;

      return {
        z: formatNumber(zoomLevel, 3),
        x: `(iw-iw/zoom)*(${horizontalBudget.startRatio}+${horizontalBudget.travelRatio}*${easedProgress})`,
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
  const normalizedOverlayText = ensureNonEmptyString(overlayText, 'overlay_text');
  const normalizedWidth = normalizePositiveInteger(width, DEFAULT_WIDTH, 'width');
  const normalizedHeight = normalizePositiveInteger(height, DEFAULT_HEIGHT, 'height');
  const normalizedFps = normalizePositiveInteger(fps, DEFAULT_FPS, 'fps');
  const normalizedDurationSeconds = normalizePositiveNumber(durationSeconds, 5, 'duration_seconds');
  const normalizedFontSize = normalizePositiveInteger(fontSize, DEFAULT_FONT_SIZE, 'font_size');
  const totalFrames = Math.max(Math.round(normalizedDurationSeconds * normalizedFps), 2);
  const sourceWidth = Math.ceil(normalizedWidth * 1.25);
  const sourceHeight = Math.ceil(normalizedHeight * 1.25);
  const imageMotion = buildImageMotionExpressions(normalizedSceneAnimation, {
    durationSeconds: normalizedDurationSeconds,
    totalFrames,
    sourceWidth,
    sourceHeight,
  });
  const textMotion = buildTextAnimationExpressions(normalizedSceneAnimation, normalizedDurationSeconds);

  return [
    `[0:v]scale=${sourceWidth}:${sourceHeight}:force_original_aspect_ratio=increase`,
    `crop=${sourceWidth}:${sourceHeight}`,
    `zoompan=z='${escapeExpression(imageMotion.z)}':x='${escapeExpression(imageMotion.x)}':y='${escapeExpression(imageMotion.y)}':d=1:s=${normalizedWidth}x${normalizedHeight}:fps=${normalizedFps}`,
    `drawtext=fontfile='${escapeFilterLiteral(fontFile)}':text='${escapeDrawtextText(normalizedOverlayText)}':fontcolor=${fontColor}:fontsize=${normalizedFontSize}:x='${escapeExpression(textMotion.x)}':y='${escapeExpression(textMotion.y)}':alpha='${escapeExpression(textMotion.alpha)}':borderw=4:bordercolor=${borderColor}:shadowcolor=black@0.85:shadowx=2:shadowy=2:line_spacing=8`,
    'format=yuv420p[vout]',
  ].join(',');
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

  if (clipPath == null && clipBinary == null) {
    throw new Error(`clips[${index}] must include clip_path or clip_binary.`);
  }

  if (clipPath != null && clipBinary != null) {
    throw new Error(`clips[${index}] must not include both clip_path and clip_binary.`);
  }

  return {
    clip_path: clipPath == null ? null : ensureNonEmptyString(clipPath, `clips[${index}].clip_path`),
    clip_binary: clipBinary ?? null,
    transition_to_next: validateSceneTransition(
      clip.transition_to_next,
      { label: `clips[${index}].transition_to_next` }
    ),
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
    totalDurationSeconds += segmentDuration;
  });

  if (inputLabels.length > 1) {
    filterParts.push(`${inputLabels.join('')}concat=n=${inputLabels.length}:v=0:a=1[aout]`);
  }

  return {
    filterGraph: filterParts.join(';'),
    outputLabel: inputLabels.length > 1 ? 'aout' : 'a0',
    totalDurationSeconds: Number(formatNumber(totalDurationSeconds, 3)),
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

function normalizeAudioCodec(codec) {
  return normalizeOptionalString(codec, DEFAULT_AUDIO_CODEC);
}

function normalizeAudioBitrate(value) {
  return normalizeOptionalString(value, DEFAULT_AUDIO_BITRATE);
}

function normalizeAudioSampleRate(value) {
  return normalizePositiveInteger(value, DEFAULT_AUDIO_SAMPLE_RATE, 'audio_sample_rate');
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
  const filePath = path.join(tempDir, `${baseName}${getUploadExtension(normalizedUpload, fallbackExtension)}`);
  await writeFile(filePath, normalizedUpload.buffer);
  return filePath;
}

export function getGenerateClipDurationSeconds(requestBody) {
  return normalizePositiveNumber(
    requestBody.duration_seconds ?? requestBody.durationSeconds ?? requestBody.duration,
    5,
    'duration_seconds'
  );
}

export async function materializeGenerateClipBinaryInputs(requestBody, tempRoot = tmpdir()) {
  const imageBinary = requestBody.image_binary ?? requestBody.imageBinary;
  const voiceoverBinary = requestBody.voiceover_binary ?? requestBody.voiceoverBinary;

  if (imageBinary == null && voiceoverBinary == null) {
    return null;
  }

  const tempDir = await mkdtemp(path.join(tempRoot, GENERATE_CLIP_UPLOAD_DIR_PREFIX));

  try {
    if (imageBinary != null && imageBinary.buffer == null) {
      throw new Error('image_binary must be sent as an n8n binary file upload.');
    }

    if (voiceoverBinary != null && voiceoverBinary.buffer == null) {
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
        await rm(tempDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

export async function materializeProbeAudioBinaryInput(requestBody, tempRoot = tmpdir()) {
  const audioBinary = requestBody.audio_binary ?? requestBody.audioBinary;

  if (audioBinary == null) {
    return null;
  }

  const tempDir = await mkdtemp(path.join(tempRoot, PROBE_AUDIO_UPLOAD_DIR_PREFIX));

  try {
    if (audioBinary.buffer == null) {
      throw new Error('audio_binary must be sent as an n8n binary file upload.');
    }

    assertWavUpload(audioBinary, 'audio_binary');

    return {
      temp_dir: tempDir,
      audio_path: await writeBinaryUploadToTempFile(audioBinary, tempDir, 'audio-upload', '.wav'),
      filename: getUploadFilename(audioBinary, 'audio_binary') || 'audio.wav',
      mime_type: getUploadMimeType(audioBinary, 'audio_binary') || 'audio/wav',
      cleanup: async () => {
        await rm(tempDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

export async function materializeJoinClipsInputs(requestBody, tempRoot = tmpdir()) {
  if (!requestBody || typeof requestBody !== 'object') {
    throw new Error('The request body must be an object.');
  }

  if (!Array.isArray(requestBody.clips) || requestBody.clips.length === 0) {
    throw new Error('clips must be a non-empty array.');
  }

  const normalizedClipEntries = requestBody.clips.map((clip, index) => normalizeJoinClipsRequestEntry(clip, index));
  const needsTempDir = normalizedClipEntries.some((clip) => clip.clip_binary != null);
  const tempDir = needsTempDir
    ? await mkdtemp(path.join(tempRoot, JOIN_CLIPS_UPLOAD_DIR_PREFIX))
    : null;

  try {
    normalizedClipEntries.forEach((clip, index) => {
      if (clip.clip_binary != null && clip.clip_binary.buffer == null) {
        throw new Error(`clips[${index}].clip_binary must be sent as an n8n binary file upload.`);
      }
    });

    return {
      temp_dir: tempDir,
      clips: await Promise.all(normalizedClipEntries.map(async (clip, index) => ({
        clip_path: clip.clip_binary == null
          ? resolveWorkspacePath(clip.clip_path, `clips[${index}].clip_path`)
          : await writeBinaryUploadToTempFile(clip.clip_binary, tempDir, `clip-${String(index + 1).padStart(2, '0')}`, '.mp4'),
        transition_to_next: clip.transition_to_next,
      }))),
      cleanup: async () => {
        if (tempDir != null) {
          await rm(tempDir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    if (tempDir != null) {
      await rm(tempDir, { recursive: true, force: true });
    }
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

  if (materializedVoiceoverPath == null) {
    return null;
  }

  return {
    voiceover_path: materializedVoiceoverPath,
    voiceover_mix: normalizeVoiceoverMix(requestBody.voiceover_mix ?? requestBody.voiceoverMix, durationSeconds),
    audio_codec: normalizeAudioCodec(requestBody.audio_codec ?? requestBody.audioCodec),
    audio_bitrate: normalizeAudioBitrate(requestBody.audio_bitrate ?? requestBody.audioBitrate),
    audio_sample_rate: normalizeAudioSampleRate(requestBody.audio_sample_rate ?? requestBody.audioSampleRate),
  };
}

export function buildGenerateClipFfmpegArgs({
  imagePath,
  outputPath,
  filterGraph,
  durationSeconds,
  fps,
  videoCodec,
  encodePreset,
  crf,
  audio,
}) {
  const args = [
    '-y',
    '-loop',
    '1',
    '-framerate',
    String(fps),
    '-t',
    formatNumber(durationSeconds, 3),
    '-i',
    imagePath,
  ];

  if (audio) {
    args.push(
      '-i',
      audio.voiceover_path,
    );
  }

  args.push(
    '-filter_complex',
    filterGraph,
    '-map',
    '[vout]'
  );

  if (audio) {
    const voiceoverFilterParts = [
      `[1:a]aresample=${audio.audio_sample_rate}`,
      `apad=whole_dur=${formatNumber(durationSeconds, 3)}`,
      `atrim=duration=${formatNumber(durationSeconds, 3)}`,
      'asetpts=PTS-STARTPTS',
      `volume=${formatNumber(audio.voiceover_mix.volume, 3)}`,
    ];

    if (audio.voiceover_mix.fade_out_seconds > 0) {
      voiceoverFilterParts.push(
        `afade=t=out:st=${formatNumber(durationSeconds - audio.voiceover_mix.fade_out_seconds, 3)}:d=${formatNumber(audio.voiceover_mix.fade_out_seconds, 3)}`
      );
    }

    args.push(
      '-filter:a',
      voiceoverFilterParts.join(','),
      '-map',
      '1:a:0',
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
    '-filter_complex',
    filterGraph,
    '-map',
    `[${outputLabel}]`,
  ];

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

  try {
    if (materializedInputs?.image_path == null) {
      throw new Error('image_binary is required.');
    }

    const imagePath = materializedInputs.image_path;
    const outputPath = path.join(materializedInputs.temp_dir, 'generate-clip.mp4');
    const overlayText = ensureNonEmptyString(requestBody.overlay_text ?? requestBody.overlayText, 'overlay_text');
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
    const filterGraph = buildImageTextSceneFilterGraph({
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

    logInfo('render.generate_clip.started', {
      duration_seconds: Number(formatNumber(durationSeconds, 3)),
      width,
      height,
      fps,
      has_voiceover: audio != null,
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
      durationSeconds,
      fps,
      videoCodec,
      encodePreset,
      crf,
      audio,
    }));

    const outputBuffer = await readFile(outputPath);

    logInfo('render.generate_clip.completed', {
      duration_seconds: Number(formatNumber(durationSeconds, 3)),
      width,
      height,
      fps,
      has_voiceover: audio != null,
      output_filename: 'generate-clip.mp4',
      output_size_bytes: outputBuffer.length,
    });

    return {
      buffer: outputBuffer,
      content_type: 'video/mp4',
      filename: 'generate-clip.mp4',
      duration_seconds: Number(formatNumber(durationSeconds, 3)),
      width,
      height,
      fps,
      has_voiceover: audio != null,
      scene_animation: sceneAnimation,
    };
  } finally {
    await materializedInputs?.cleanup?.();
  }
}

export async function joinVideoClips(requestBody) {
  if (!requestBody || typeof requestBody !== 'object') {
    throw new Error('The request body must be an object.');
  }

  const materializedInputs = await materializeJoinClipsInputs(requestBody);
  const outputDir = materializedInputs.temp_dir ?? await mkdtemp(path.join(tmpdir(), JOIN_CLIPS_UPLOAD_DIR_PREFIX));
  const ownsOutputDir = materializedInputs.temp_dir == null;

  try {
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
    const hasAudio = clipStreamInfos.some((clipInfo) => clipInfo.has_audio);
    const audioGraph = hasAudio
      ? buildJoinClipsAudioFilterGraph({
        clips,
        durations,
        audioTracks: clipStreamInfos.map((clipInfo) => clipInfo.has_audio),
      })
      : null;

    logInfo('compose.join_clips.audio_plan', {
      clip_count: clips.length,
      video_durations_seconds: durations.map((duration) => Number(formatNumber(duration, 3))),
      audio_tracks: clipStreamInfos.map((clipInfo) => clipInfo.has_audio),
      has_audio: hasAudio,
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
      },
    }));

    const outputBuffer = await readFile(outputPath);

    logInfo('compose.join_clips.completed', {
      clip_count: clips.length,
      total_duration_seconds: totalDurationSeconds,
      width,
      height,
      fps,
      has_audio: hasAudio,
      output_filename: 'join-clips.mp4',
      output_size_bytes: outputBuffer.length,
    });

    return {
      buffer: outputBuffer,
      content_type: 'video/mp4',
      filename: 'join-clips.mp4',
      total_duration_seconds: totalDurationSeconds,
      width,
      height,
      fps,
      has_audio: hasAudio,
      clips: clips.map((clip) => ({
        clip_path: clip.clip_path,
        transition_to_next: clip.transition_to_next,
      })),
    };
  } finally {
    await materializedInputs.cleanup();
    if (ownsOutputDir) {
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
  };
}
