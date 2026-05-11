import argparse
import json
from pathlib import Path


SUBTITLE_THEME_PROFILES = {
    'default': {
        'font_name': 'DejaVu Sans',
        'font_size': 30,
        'base_colour': '&H00FFFFFF',
        'highlight_colour': '&H004AD5FF',
        'outline_colour': '&H00101010',
        'back_colour': '&H64000000',
        'alignment': 2,
        'margin_l': 80,
        'margin_r': 80,
        'margin_v': 64,
        'bold': -1,
        'uppercase': False,
    },
    'lime': {
        'font_name': 'DejaVu Sans',
        'font_size': 32,
        'base_colour': '&H00FFFFFF',
        'highlight_colour': '&H0056FF6A',
        'outline_colour': '&H00101010',
        'back_colour': '&H64000000',
        'alignment': 2,
        'margin_l': 76,
        'margin_r': 76,
        'margin_v': 60,
        'bold': -1,
        'uppercase': False,
    },
    'top': {
        'font_name': 'DejaVu Sans',
        'font_size': 28,
        'base_colour': '&H00FFFFFF',
        'highlight_colour': '&H00759CFF',
        'outline_colour': '&H00101010',
        'back_colour': '&H64000000',
        'alignment': 8,
        'margin_l': 84,
        'margin_r': 84,
        'margin_v': 72,
        'bold': -1,
        'uppercase': False,
    },
    'caps': {
        'font_name': 'DejaVu Sans',
        'font_size': 34,
        'base_colour': '&H00FFFFFF',
        'highlight_colour': '&H0000D7FF',
        'outline_colour': '&H00101010',
        'back_colour': '&H64000000',
        'alignment': 2,
        'margin_l': 72,
        'margin_r': 72,
        'margin_v': 58,
        'bold': -1,
        'uppercase': True,
    },
}


def parse_args():
    parser = argparse.ArgumentParser(
        description='Align a provided transcript against an audio file with WhisperX and write subtitles.'
    )
    parser.add_argument('--audio-path', required=True)
    parser.add_argument('--transcript-path', required=True)
    parser.add_argument('--output-path', required=True)
    parser.add_argument('--language', required=True)
    parser.add_argument('--device', default='cpu')
    parser.add_argument('--model-cache-dir')
    parser.add_argument('--max-line-width', type=int, default=42)
    parser.add_argument('--max-line-count', type=int, default=2)
    parser.add_argument('--theme', choices=sorted(SUBTITLE_THEME_PROFILES.keys()), default='default')
    parser.add_argument('--highlight-words', action='store_true')
    return parser.parse_args()


def resolve_subtitle_theme_profile(theme: str):
    try:
        return SUBTITLE_THEME_PROFILES[theme]
    except KeyError as error:
        raise ValueError(f'Unsupported subtitle theme: {theme}') from error


def transform_subtitle_text(text: str, theme_profile) -> str:
    normalized_text = str(text)
    if theme_profile['uppercase']:
        return normalized_text.upper()
    return normalized_text


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


def format_ass_timestamp(seconds: float) -> str:
    total_centiseconds = int(round(max(seconds, 0.0) * 100))
    hours, remainder = divmod(total_centiseconds, 360_000)
    minutes, remainder = divmod(remainder, 6_000)
    whole_seconds, centiseconds = divmod(remainder, 100)
    return f'{hours}:{minutes:02d}:{whole_seconds:02d}.{centiseconds:02d}'


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


def escape_ass_text(text: str) -> str:
    return str(text).replace('\\', r'\\').replace('{', r'\{').replace('}', r'\}').replace('\n', r'\N')


def group_words_into_lines(words, max_line_width: int, max_line_count: int):
    if not words:
        return []

    lines = []
    current_line = []
    current_length = 0

    for word in words:
        word_text = word['text']
        proposed_length = current_length + (1 if current_line else 0) + len(word_text)

        if current_line and proposed_length > max_line_width and len(lines) + 1 < max_line_count:
            lines.append(current_line)
            current_line = [word]
            current_length = len(word_text)
            continue

        current_line.append(word)
        current_length = proposed_length

    if current_line:
        if len(lines) < max_line_count:
            lines.append(current_line)
        elif lines:
            lines[-1].extend(current_line)
        else:
            lines.append(current_line)

    return lines


def build_karaoke_ass_text(words, segment_end: float, max_line_width: int, max_line_count: int) -> str:
    if not words:
        return ''

    word_lines = group_words_into_lines(words, max_line_width, max_line_count)
    durations = []

    for index, word in enumerate(words):
        if index + 1 < len(words):
            duration_seconds = max(words[index + 1]['start'] - word['start'], 0.01)
        else:
            duration_seconds = max(segment_end - word['start'], word['end'] - word['start'], 0.01)

        durations.append(max(1, int(round(duration_seconds * 100))))

    parts = []
    flattened_index = 0
    for line_index, line_words in enumerate(word_lines):
        if line_index > 0:
            parts.append(r'\N')

        for word_index, word in enumerate(line_words):
            if word_index > 0:
                parts.append(' ')

            parts.append(r'{\k')
            parts.append(str(durations[flattened_index]))
            parts.append('}')
            parts.append(escape_ass_text(word['text']))
            flattened_index += 1

    return ''.join(parts)


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

        normalized_words = []
        for word in segment.get('words', []):
            word_text = str(word.get('word', '')).strip()
            if not word_text:
                continue

            word_start = float(word.get('start', segment_start))
            word_end = float(word.get('end', word_start))
            if word_end < word_start:
                word_end = word_start

            normalized_words.append({
                'text': word_text,
                'start': word_start,
                'end': word_end,
            })

        if normalized_words:
            segment_start = normalized_words[0]['start']
            segment_end = max(segment_end, normalized_words[-1]['end'])

        aligned_segments.append({
            'start': segment_start,
            'end': segment_end,
            'text': wrap_subtitle_text(segment_text, max_line_width, max_line_count),
            'words': normalized_words,
        })

    if aligned_segments:
        return aligned_segments

    return [{
        'start': 0.0,
        'end': round(audio_duration_seconds, 3),
        'text': wrap_subtitle_text(transcript, max_line_width, max_line_count),
        'words': [],
    }]


def write_srt(output_path: str, segments) -> None:
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    with output.open('w', encoding='utf-8') as handle:
        for index, segment in enumerate(segments, start=1):
            handle.write(f'{index}\n')
            handle.write(f"{format_timestamp(segment['start'])} --> {format_timestamp(segment['end'])}\n")
            handle.write(f"{segment['text']}\n\n")


def build_ass_dialogue_text(segment: dict, max_line_width: int, max_line_count: int, highlight_words: bool) -> str:
    if highlight_words and segment.get('words'):
        return build_karaoke_ass_text(segment['words'], segment['end'], max_line_width, max_line_count)

    return escape_ass_text(wrap_subtitle_text(segment['text'], max_line_width, max_line_count)).replace('\n', r'\N')


def build_ass_style_line(theme_profile) -> str:
    return (
        'Style: ViralCaption,'
        f"{theme_profile['font_name']},{theme_profile['font_size']},"
        f"{theme_profile['highlight_colour']},{theme_profile['base_colour']},"
        f"{theme_profile['outline_colour']},{theme_profile['back_colour']},"
        f"{theme_profile['bold']},0,0,0,100,100,0,0,1,3,0,"
        f"{theme_profile['alignment']},{theme_profile['margin_l']},{theme_profile['margin_r']},{theme_profile['margin_v']},1"
    )


def write_ass(output_path: str, segments, max_line_width: int, max_line_count: int, highlight_words: bool, theme_profile) -> None:
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    header = """[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

    with output.open('w', encoding='utf-8') as handle:
        handle.write(header)
        handle.write(f"{build_ass_style_line(theme_profile)}\n")
        for segment in segments:
            dialogue_text = build_ass_dialogue_text(segment, max_line_width, max_line_count, highlight_words)
            handle.write(
                f"Dialogue: 0,{format_ass_timestamp(segment['start'])},{format_ass_timestamp(segment['end'])},ViralCaption,,0,0,0,,{dialogue_text}\n"
            )


def write_output(output_path: str, segments, max_line_width: int, max_line_count: int, highlight_words: bool, theme_profile) -> str:
    output_suffix = Path(output_path).suffix.lower()

    if output_suffix == '.ass':
        write_ass(output_path, segments, max_line_width, max_line_count, highlight_words, theme_profile)
        return 'ass'

    write_srt(output_path, segments)
    return 'srt'


def align_transcript(audio_path: str, transcript: str, language: str, device: str, model_cache_dir: str | None):
    import whisperx
    from whisperx.audio import SAMPLE_RATE

    audio = whisperx.load_audio(audio_path)
    audio_duration_seconds = len(audio) / SAMPLE_RATE
    align_model, align_metadata = whisperx.load_align_model(
        language_code=language,
        device=device,
        model_dir=model_cache_dir,
        model_cache_only=False,
    )
    aligned_result = whisperx.align(
        build_transcript_segments(transcript, audio_duration_seconds),
        align_model,
        align_metadata,
        audio,
        device,
        return_char_alignments=False,
    )

    return aligned_result, audio_duration_seconds


def main():
    args = parse_args()
    transcript = read_transcript(args.transcript_path)
    theme_profile = resolve_subtitle_theme_profile(args.theme)
    aligned_result, audio_duration_seconds = align_transcript(
        args.audio_path,
        transcript,
        args.language,
        args.device,
        args.model_cache_dir,
    )
    normalized_segments = normalize_aligned_segments(
        aligned_result,
        transform_subtitle_text(transcript, theme_profile),
        audio_duration_seconds,
        args.max_line_width,
        args.max_line_count,
    )

    for segment in normalized_segments:
        segment['text'] = transform_subtitle_text(segment['text'], theme_profile)
        segment['words'] = [
            {
                **word,
                'text': transform_subtitle_text(word['text'], theme_profile),
            }
            for word in segment.get('words', [])
        ]

    output_format = write_output(
        args.output_path,
        normalized_segments,
        args.max_line_width,
        args.max_line_count,
        args.highlight_words,
        theme_profile,
    )
    print(json.dumps({
        'ok': True,
        'cue_count': len(normalized_segments),
        'format': output_format,
        'highlight_words': args.highlight_words,
        'theme': args.theme,
        'output_path': str(Path(args.output_path)),
    }))


if __name__ == '__main__':
    main()
