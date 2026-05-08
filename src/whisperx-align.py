import argparse
import json
from pathlib import Path

import whisperx
from whisperx.audio import SAMPLE_RATE


def parse_args():
    parser = argparse.ArgumentParser(
        description='Align a provided transcript against an audio file with WhisperX and write an SRT.'
    )
    parser.add_argument('--audio-path', required=True)
    parser.add_argument('--transcript-path', required=True)
    parser.add_argument('--output-path', required=True)
    parser.add_argument('--language', required=True)
    parser.add_argument('--device', default='cpu')
    parser.add_argument('--model-cache-dir')
    parser.add_argument('--max-line-width', type=int, default=42)
    parser.add_argument('--max-line-count', type=int, default=2)
    return parser.parse_args()


def read_transcript(transcript_path: str) -> str:
    transcript = Path(transcript_path).read_text(encoding='utf-8').strip()
    if not transcript:
        raise ValueError('Transcript text is empty.')
    return transcript


def format_timestamp(seconds: float) -> str:
    total_milliseconds = int(round(max(seconds, 0.0) * 1000))
    hours, remainder = divmod(total_milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    whole_seconds, milliseconds = divmod(remainder, 1000)
    return f'{hours:02d}:{minutes:02d}:{whole_seconds:02d},{milliseconds:03d}'


def wrap_subtitle_text(text: str, max_line_width: int, max_line_count: int) -> str:
    words = text.split()
    if not words:
        return text.strip()

    lines = []
    current_line = []

    for word in words:
        proposed_line = ' '.join(current_line + [word]) if current_line else word
        if current_line and len(proposed_line) > max_line_width and len(lines) + 1 < max_line_count:
            lines.append(' '.join(current_line))
            current_line = [word]
            continue

        current_line.append(word)

    if current_line:
        remaining_text = ' '.join(current_line)
        if len(lines) < max_line_count:
            lines.append(remaining_text)
        elif lines:
            lines[-1] = f'{lines[-1]} {remaining_text}'.strip()
        else:
            lines.append(remaining_text)

    return '\n'.join(lines)


def build_transcript_segments(transcript: str, audio_duration_seconds: float):
    return [{
        'start': 0.0,
        'end': round(audio_duration_seconds, 3),
        'text': transcript,
    }]


def normalize_aligned_segments(result: dict, transcript: str, audio_duration_seconds: float, max_line_width: int, max_line_count: int):
    aligned_segments = []

    for segment in result.get('segments', []):
        segment_text = str(segment.get('text', '')).strip()
        if not segment_text:
            continue

        segment_start = float(segment.get('start', 0.0))
        segment_end = float(segment.get('end', segment_start))
        if segment_end < segment_start:
            segment_end = segment_start

        aligned_segments.append({
            'start': segment_start,
            'end': segment_end,
            'text': wrap_subtitle_text(segment_text, max_line_width, max_line_count),
        })

    if aligned_segments:
        return aligned_segments

    return [{
        'start': 0.0,
        'end': round(audio_duration_seconds, 3),
        'text': wrap_subtitle_text(transcript, max_line_width, max_line_count),
    }]


def write_srt(output_path: str, segments) -> None:
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    with output.open('w', encoding='utf-8') as handle:
        for index, segment in enumerate(segments, start=1):
            handle.write(f'{index}\n')
            handle.write(f"{format_timestamp(segment['start'])} --> {format_timestamp(segment['end'])}\n")
            handle.write(f"{segment['text']}\n\n")


def main():
    args = parse_args()
    transcript = read_transcript(args.transcript_path)
    audio = whisperx.load_audio(args.audio_path)
    audio_duration_seconds = len(audio) / SAMPLE_RATE

    align_model, align_metadata = whisperx.load_align_model(
        language_code=args.language,
        device=args.device,
        model_dir=args.model_cache_dir,
        model_cache_only=False,
    )
    aligned_result = whisperx.align(
        build_transcript_segments(transcript, audio_duration_seconds),
        align_model,
        align_metadata,
        audio,
        args.device,
        return_char_alignments=False,
    )
    normalized_segments = normalize_aligned_segments(
        aligned_result,
        transcript,
        audio_duration_seconds,
        args.max_line_width,
        args.max_line_count,
    )

    write_srt(args.output_path, normalized_segments)
    print(json.dumps({
        'ok': True,
        'cue_count': len(normalized_segments),
        'output_path': str(Path(args.output_path)),
    }))


if __name__ == '__main__':
    main()