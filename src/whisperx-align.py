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

SUBTITLE_LAYOUT_BASE_WIDTH = 1920
SUBTITLE_LAYOUT_BASE_HEIGHT = 1080


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
    parser.add_argument('--playres-x', type=int, default=1920)
    parser.add_argument('--playres-y', type=int, default=1080)
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


def get_scaled_theme_profile(theme_profile, play_res_x: int, play_res_y: int):
    normalized_play_res_x = max(int(play_res_x), 1)
    normalized_play_res_y = max(int(play_res_y), 1)
    layout_scale = min(
        normalized_play_res_x / SUBTITLE_LAYOUT_BASE_WIDTH,
        normalized_play_res_y / SUBTITLE_LAYOUT_BASE_HEIGHT,
        1.0,
    )

    return {
        **theme_profile,
        'font_size': min(theme_profile['font_size'], max(int(round(theme_profile['font_size'] * layout_scale)), 12)),
        'margin_l': min(theme_profile['margin_l'], max(int(round(theme_profile['margin_l'] * layout_scale)), 24)),
        'margin_r': min(theme_profile['margin_r'], max(int(round(theme_profile['margin_r'] * layout_scale)), 24)),
        'margin_v': min(theme_profile['margin_v'], max(int(round(theme_profile['margin_v'] * layout_scale)), 20)),
    }


def resolve_subtitle_text_layout(theme_profile, play_res_x: int, play_res_y: int):
    normalized_play_res_x = max(int(play_res_x), 1)
    normalized_play_res_y = max(int(play_res_y), 1)
    is_portrait_or_narrow = normalized_play_res_y > normalized_play_res_x or normalized_play_res_x < 900
    max_line_count = 3 if is_portrait_or_narrow else 2
    available_width = max(normalized_play_res_x - theme_profile['margin_l'] - theme_profile['margin_r'], 120)
    average_character_width = max(
        theme_profile['font_size'] * (0.78 if theme_profile['uppercase'] else 0.68),
        1,
    )
    max_line_width_cap = 18 if normalized_play_res_x <= 540 else 24 if is_portrait_or_narrow else 32
    max_line_width = max(12, min(int(available_width / average_character_width), max_line_width_cap))

    return {
        'max_line_width': max_line_width,
        'max_line_count': max_line_count,
    }


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


def get_token_text(token) -> str:
    if isinstance(token, dict):
        return str(token.get('text', ''))
    return str(token)


def partition_tokens_into_lines(tokens, max_line_width: int, max_line_count: int):
    if not tokens:
        return []

    normalized_tokens = list(tokens)
    max_line_count = max(1, int(max_line_count))
    token_texts = [get_token_text(token) for token in normalized_tokens]
    token_count = len(normalized_tokens)

    prefix_lengths = [0]
    for token_text in token_texts:
        prefix_lengths.append(prefix_lengths[-1] + len(token_text))

    def line_length(start_index: int, end_index: int) -> int:
        words_in_line = end_index - start_index
        return prefix_lengths[end_index] - prefix_lengths[start_index] + max(words_in_line - 1, 0)

    infinity = float('inf')
    best_costs = [[infinity] * (max_line_count + 1) for _ in range(token_count + 1)]
    previous_breaks = [[None] * (max_line_count + 1) for _ in range(token_count + 1)]
    best_costs[0][0] = 0

    for end_index in range(1, token_count + 1):
        for line_count in range(1, min(max_line_count, end_index) + 1):
            for start_index in range(line_count - 1, end_index):
                previous_cost = best_costs[start_index][line_count - 1]
                if previous_cost == infinity:
                    continue

                candidate_cost = max(previous_cost, line_length(start_index, end_index))
                if candidate_cost < best_costs[end_index][line_count]:
                    best_costs[end_index][line_count] = candidate_cost
                    previous_breaks[end_index][line_count] = start_index

    chosen_line_count = None
    for line_count in range(1, max_line_count + 1):
        if best_costs[token_count][line_count] <= max_line_width:
            chosen_line_count = line_count
            break

    if chosen_line_count is None:
        chosen_line_count = min(
            range(1, max_line_count + 1),
            key=lambda line_count: (best_costs[token_count][line_count], line_count),
        )

    lines = []
    end_index = token_count
    line_count = chosen_line_count

    while line_count > 0 and end_index > 0:
        start_index = previous_breaks[end_index][line_count]
        if start_index is None:
            break
        lines.append(normalized_tokens[start_index:end_index])
        end_index = start_index
        line_count -= 1

    lines.reverse()
    return [line for line in lines if line]


def wrap_subtitle_text(text: str, max_line_width: int, max_line_count: int) -> str:
    words = text.split()
    if not words:
        return text.strip()

    lines = partition_tokens_into_lines(words, max_line_width, max_line_count)
    return '\n'.join(' '.join(line) for line in lines)


def escape_ass_text(text: str) -> str:
    return str(text).replace('\\', r'\\').replace('{', r'\{').replace('}', r'\}').replace('\n', r'\N')


def group_words_into_lines(words, max_line_width: int, max_line_count: int):
    return partition_tokens_into_lines(words, max_line_width, max_line_count)


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


def resolve_centered_alignment(alignment: int) -> int:
    if alignment >= 7:
        return 8
    if alignment >= 4:
        return 5
    return 2


def build_ass_position_override(theme_profile, play_res_x: int, play_res_y: int) -> str:
    normalized_play_res_x = max(int(play_res_x), 1)
    normalized_play_res_y = max(int(play_res_y), 1)
    centered_alignment = resolve_centered_alignment(int(theme_profile['alignment']))
    x_position = normalized_play_res_x // 2

    if centered_alignment >= 7:
        y_position = theme_profile['margin_v']
    elif centered_alignment >= 4:
        y_position = normalized_play_res_y // 2
    else:
        y_position = normalized_play_res_y - theme_profile['margin_v']

    return f'{{\\an{centered_alignment}\\pos({x_position},{y_position})}}'


def build_ass_header(play_res_x: int, play_res_y: int) -> str:
    normalized_play_res_x = max(int(play_res_x), 1)
    normalized_play_res_y = max(int(play_res_y), 1)

    return f"""[Script Info]
ScriptType: v4.00+
PlayResX: {normalized_play_res_x}
PlayResY: {normalized_play_res_y}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def write_ass(output_path: str, segments, max_line_width: int, max_line_count: int, highlight_words: bool, theme_profile, play_res_x: int, play_res_y: int) -> None:
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    header = build_ass_header(play_res_x, play_res_y)
    position_override = build_ass_position_override(theme_profile, play_res_x, play_res_y)

    with output.open('w', encoding='utf-8') as handle:
        handle.write(header)
        handle.write(f"{build_ass_style_line(theme_profile)}\n")
        for segment in segments:
            dialogue_text = build_ass_dialogue_text(segment, max_line_width, max_line_count, highlight_words)
            handle.write(
                f"Dialogue: 0,{format_ass_timestamp(segment['start'])},{format_ass_timestamp(segment['end'])},ViralCaption,,0,0,0,,{position_override}{dialogue_text}\n"
            )


def write_output(output_path: str, segments, max_line_width: int, max_line_count: int, highlight_words: bool, theme_profile, play_res_x: int, play_res_y: int) -> str:
    output_suffix = Path(output_path).suffix.lower()

    if output_suffix == '.ass':
        write_ass(output_path, segments, max_line_width, max_line_count, highlight_words, theme_profile, play_res_x, play_res_y)
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
    theme_profile = get_scaled_theme_profile(
        resolve_subtitle_theme_profile(args.theme),
        args.playres_x,
        args.playres_y,
    )
    subtitle_text_layout = resolve_subtitle_text_layout(theme_profile, args.playres_x, args.playres_y)
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
        args.max_line_width if args.max_line_width > 0 else subtitle_text_layout['max_line_width'],
        args.max_line_count if args.max_line_count > 0 else subtitle_text_layout['max_line_count'],
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
        args.max_line_width if args.max_line_width > 0 else subtitle_text_layout['max_line_width'],
        args.max_line_count if args.max_line_count > 0 else subtitle_text_layout['max_line_count'],
        args.highlight_words,
        theme_profile,
        args.playres_x,
        args.playres_y,
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
