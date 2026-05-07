import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

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
const DEFAULT_AUDIO_CODEC = 'aac';
const DEFAULT_AUDIO_BITRATE = '192k';
const DEFAULT_AUDIO_SAMPLE_RATE = 48000;
const DEFAULT_FONT_SIZE = 72;
const DEFAULT_FONT_COLOR = 'white';
const DEFAULT_BORDER_COLOR = 'black@0.45';

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
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

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

function buildImageMotionExpressions(sceneAnimation, totalFrames) {
  const lastFrameIndex = Math.max(totalFrames - 1, 1);
  const progress = `on/${lastFrameIndex}`;

  switch (sceneAnimation.image_motion_preset) {
    case 'static_hold':
      return {
        z: '1.03',
        x: 'iw/2-(iw/zoom/2)',
        y: 'ih/2-(ih/zoom/2)',
      };
    case 'slow_push_in': {
      const finalZoom = sceneAnimation.speed === 'slow' ? 1.1 : 1.16;
      const step = (finalZoom - 1) / lastFrameIndex;
      return {
        z: `1+on*${formatNumber(step)}`,
        x: 'iw/2-(iw/zoom/2)',
        y: 'ih/2-(ih/zoom/2)',
      };
    }
    case 'slow_pull_out': {
      const initialZoom = sceneAnimation.speed === 'slow' ? 1.12 : 1.18;
      const step = (initialZoom - 1) / lastFrameIndex;
      return {
        z: `${formatNumber(initialZoom)}-on*${formatNumber(step)}`,
        x: 'iw/2-(iw/zoom/2)',
        y: 'ih/2-(ih/zoom/2)',
      };
    }
    case 'pan_left_slow':
      return {
        z: sceneAnimation.speed === 'slow' ? '1.08' : '1.12',
        x: `(iw-iw/zoom)*${progress}`,
        y: 'ih/2-(ih/zoom/2)',
      };
    case 'pan_right_slow':
      return {
        z: sceneAnimation.speed === 'slow' ? '1.08' : '1.12',
        x: `(iw-iw/zoom)*(1-${progress})`,
        y: 'ih/2-(ih/zoom/2)',
      };
    case 'drift_up_soft':
      return {
        z: sceneAnimation.speed === 'slow' ? '1.06' : '1.1',
        x: 'iw/2-(iw/zoom/2)',
        y: `(ih-ih/zoom)*(1-${progress})`,
      };
    case 'drift_down_soft':
      return {
        z: sceneAnimation.speed === 'slow' ? '1.06' : '1.1',
        x: 'iw/2-(iw/zoom/2)',
        y: `(ih-ih/zoom)*${progress}`,
      };
    case 'parallax_float':
      return {
        z: sceneAnimation.speed === 'slow' ? '1.08' : '1.12',
        x: '(iw-iw/zoom)*(0.5+0.08*sin(on/12))',
        y: '(ih-ih/zoom)*(0.48+0.06*cos(on/15))',
      };
    default:
      throw new Error(`Unsupported image motion preset: ${sceneAnimation.image_motion_preset}`);
  }
}

function buildTextAnimationExpressions(sceneAnimation) {
  const baseX = '(w-text_w)/2';
  const baseY = getTextAnchorYExpression(sceneAnimation.text_anchor);
  const fadeInAlpha = 'if(lt(t,0.35),t/0.35,1)';

  switch (sceneAnimation.text_motion_preset) {
    case 'fade_in_hold':
      return { x: baseX, y: baseY, alpha: fadeInAlpha };
    case 'fade_up_soft':
      return { x: baseX, y: `${baseY}+40/(1+12*t)`, alpha: fadeInAlpha };
    case 'slide_left_soft':
      return { x: `${baseX}+90/(1+14*t)`, y: baseY, alpha: fadeInAlpha };
    case 'slide_right_soft':
      return { x: `${baseX}-90/(1+14*t)`, y: baseY, alpha: fadeInAlpha };
    case 'type_on_soft':
      return { x: baseX, y: baseY, alpha: 'if(lt(t,0.12),0,if(lt(t,0.6),(t-0.12)/0.48,1))' };
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
  const imageMotion = buildImageMotionExpressions(normalizedSceneAnimation, totalFrames);
  const textMotion = buildTextAnimationExpressions(normalizedSceneAnimation);

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

function normalizeCodec(codec) {
  return normalizeOptionalString(codec, DEFAULT_VIDEO_CODEC);
}

function normalizeEncodePreset(value) {
  return normalizeOptionalString(value, DEFAULT_ENCODE_PRESET);
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

function normalizeGenerateClipAudio(requestBody, durationSeconds) {
  const voiceoverPathValue = requestBody.voiceover_path ?? requestBody.voiceoverPath;
  if (voiceoverPathValue == null) {
    return null;
  }

  return {
    voiceover_path: resolveWorkspacePath(voiceoverPathValue, 'voiceover_path'),
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

export async function generateClip(requestBody) {
  if (!requestBody || typeof requestBody !== 'object') {
    throw new Error('The request body must be an object.');
  }

  const imagePath = resolveWorkspacePath(requestBody.image_path ?? requestBody.imagePath, 'image_path');
  const outputPath = resolveWorkspacePath(requestBody.output_path ?? requestBody.outputPath, 'output_path');
  const overlayText = ensureNonEmptyString(requestBody.overlay_text ?? requestBody.overlayText, 'overlay_text');
  const durationSeconds = normalizePositiveNumber(requestBody.duration_seconds ?? requestBody.durationSeconds, 5, 'duration_seconds');
  const width = normalizePositiveInteger(requestBody.width, DEFAULT_WIDTH, 'width');
  const height = normalizePositiveInteger(requestBody.height, DEFAULT_HEIGHT, 'height');
  const fps = normalizePositiveInteger(requestBody.fps, DEFAULT_FPS, 'fps');
  const fontSize = normalizePositiveInteger(requestBody.font_size ?? requestBody.fontSize, DEFAULT_FONT_SIZE, 'font_size');
  const fontColor = normalizeOptionalString(requestBody.font_color ?? requestBody.fontColor, DEFAULT_FONT_COLOR);
  const borderColor = normalizeOptionalString(requestBody.border_color ?? requestBody.borderColor, DEFAULT_BORDER_COLOR);
  const fontFile = normalizeOptionalString(requestBody.font_file ?? requestBody.fontFile, process.env.FONT_FILE || '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf');
  const sceneAnimation = validateSceneAnimation(requestBody.scene_animation ?? requestBody.sceneAnimation);
  const videoCodec = normalizeCodec(requestBody.video_codec ?? requestBody.videoCodec);
  const encodePreset = normalizeEncodePreset(requestBody.encode_preset ?? requestBody.encodePreset);
  const crf = normalizeCrf(requestBody.crf);
  const audio = normalizeGenerateClipAudio(requestBody, durationSeconds);
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

  return {
    output_path: outputPath,
    duration_seconds: Number(formatNumber(durationSeconds, 3)),
    width,
    height,
    fps,
    voiceover: audio
      ? {
          voiceover_path: audio.voiceover_path,
          voiceover_mix: audio.voiceover_mix,
          audio_codec: audio.audio_codec,
          audio_bitrate: audio.audio_bitrate,
          audio_sample_rate: audio.audio_sample_rate,
        }
      : null,
    scene_animation: sceneAnimation,
  };
}

export async function joinVideoClips(requestBody) {
  if (!requestBody || typeof requestBody !== 'object') {
    throw new Error('The request body must be an object.');
  }

  if (!Array.isArray(requestBody.clips) || requestBody.clips.length === 0) {
    throw new Error('clips must be a non-empty array.');
  }

  const clips = requestBody.clips.map((clip, index) => {
    const normalizedClip = normalizeClipEntry(clip, index);
    return {
      clip_path: resolveWorkspacePath(normalizedClip.clip_path, `clips[${index}].clip_path`),
      transition_to_next: normalizedClip.transition_to_next,
    };
  });

  const outputPath = resolveWorkspacePath(requestBody.output_path ?? requestBody.outputPath, 'output_path');
  const width = normalizePositiveInteger(requestBody.width, DEFAULT_WIDTH, 'width');
  const height = normalizePositiveInteger(requestBody.height, DEFAULT_HEIGHT, 'height');
  const fps = normalizePositiveInteger(requestBody.fps, DEFAULT_FPS, 'fps');
  const videoCodec = normalizeCodec(requestBody.video_codec ?? requestBody.videoCodec);
  const encodePreset = normalizeEncodePreset(requestBody.encode_preset ?? requestBody.encodePreset);
  const crf = normalizeCrf(requestBody.crf);
  const durations = await Promise.all(clips.map((clip) => probeClipDuration(clip.clip_path)));
  const { filterGraph, outputLabel, totalDurationSeconds } = buildJoinClipsFilterGraph({
    clips,
    durations,
    width,
    height,
    fps,
  });

  await mkdir(path.dirname(outputPath), { recursive: true });

  await runCommand('ffmpeg', [
    '-y',
    ...clips.flatMap((clip) => ['-i', clip.clip_path]),
    '-filter_complex',
    filterGraph,
    '-map',
    `[${outputLabel}]`,
    '-an',
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
  ]);

  return {
    output_path: outputPath,
    total_duration_seconds: totalDurationSeconds,
    width,
    height,
    fps,
    clips: clips.map((clip) => ({
      clip_path: clip.clip_path,
      transition_to_next: clip.transition_to_next,
    })),
  };
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
