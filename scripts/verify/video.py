#!/usr/bin/env python3

"""
scripts/verify/video.py
Assembles verification result artifacts (result.json, raw webm, stills, wavs)
into a polished MP4 video proof for Mission Control chat.

Supports two pipelines:
1. MoviePy pipeline: high fidelity layout, title card, caption overlays, before/after stills.
2. Fast FFmpeg pipeline (--fast): single-pass invocation with drawtext/drawbox/amix for sub-second assembly.

Enforces media limits (<= max_mb, default 9MB, H.264 + AAC, yuv420p).
Prints JSON on the last line of stdout:
{"out": "<path>", "bytes": N, "durationSec": N.N}
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time


def parse_args():
    parser = argparse.ArgumentParser(description="Assemble verification proof video.")
    parser.add_argument("--result", required=True, help="Path to result.json")
    parser.add_argument("--out", required=True, help="Output MP4 file path")
    parser.add_argument("--narrate-dir", help="Directory with generated narration wav files")
    parser.add_argument("--max-mb", type=float, default=9.0, help="Maximum allowed file size in MB (default 9.0)")
    parser.add_argument("--no-audio", action="store_true", help="Disable audio in output video")
    parser.add_argument("--fast", action="store_true", help="Use fast single-pass FFmpeg pipeline")
    parser.add_argument("--font", help="Path to TTF font file")
    parser.add_argument("--fps", type=int, default=24, help="Frame rate (default 24)")
    parser.add_argument("--title-dur", type=float, default=1.2, help="Title card duration in seconds (default 1.2)")
    parser.add_argument("--shots-dur", type=float, default=2.5, help="Before/after segment duration in seconds (default 2.5)")
    return parser.parse_args()


def resolve_font(user_font=None):
    if user_font and os.path.exists(user_font):
        return user_font
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return candidates[0]


def get_media_duration(file_path):
    if not file_path or not os.path.exists(file_path):
        return 0.0
    try:
        res = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                file_path,
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        val = res.stdout.strip()
        return float(val) if val else 0.0
    except Exception:
        return 0.0


def escape_ffmpeg_text(text):
    if not text:
        return ""
    # In ffmpeg drawtext filter: escape backslashes, single quotes, colons, percent, brackets
    text = str(text)
    text = text.replace("\\", "\\\\")
    text = text.replace("'", "\\'")
    text = text.replace(":", "\\:")
    text = text.replace("%", "\\%")
    text = text.replace("[", "\\[")
    text = text.replace("]", "\\]")
    return text


def format_title_name(raw_name):
    if not raw_name:
        return "Verification Check"
    # Convert kebab-case or snake_case to uppercase/title words
    words = str(raw_name).replace("-", " ").replace("_", " ").split()
    return " ".join(w.capitalize() for w in words)


def collect_audio_tracks(result_data, narrate_dir, title_dur, no_audio):
    if no_audio or not narrate_dir or not os.path.isdir(narrate_dir):
        return []

    tracks = []
    # 1. Title track
    title_wav = os.path.join(narrate_dir, "title.wav")
    if os.path.exists(title_wav) and os.path.getsize(title_wav) > 44:
        tracks.append({
            "id": "title",
            "path": title_wav,
            "offset_s": 0.0,
            "duration_s": get_media_duration(title_wav),
        })

    # 2. Step tracks
    steps = result_data.get("steps") or []
    for step in steps:
        step_id = step.get("id")
        if not step_id:
            continue
        step_wav = os.path.join(narrate_dir, f"{step_id}.wav")
        if os.path.exists(step_wav) and os.path.getsize(step_wav) > 44:
            start_ms = step.get("startMs", 0) or 0
            offset_s = title_dur + (start_ms / 1000.0)
            tracks.append({
                "id": step_id,
                "path": step_wav,
                "offset_s": offset_s,
                "duration_s": get_media_duration(step_wav),
            })

    return tracks


def render_fast_ffmpeg(result_data, out_path, narrate_dir, font_path, fps, initial_title_dur, shots_dur, no_audio):
    check_name = format_title_name(result_data.get("name", "Verification"))
    passed = bool(result_data.get("passed", True))
    tier = str(result_data.get("tier", "daemon"))
    duration_ms = result_data.get("durationMs", 0) or 0
    duration_s = duration_ms / 1000.0
    steps = result_data.get("steps") or []
    step_count = len(steps)

    # Check title audio to stretch title duration if needed
    title_wav = os.path.join(narrate_dir, "title.wav") if narrate_dir else None
    title_dur = initial_title_dur
    if not no_audio and title_wav and os.path.exists(title_wav):
        t_aud_dur = get_media_duration(title_wav)
        if t_aud_dur > 0:
            title_dur = max(initial_title_dur, t_aud_dur + 0.15)

    audio_tracks = collect_audio_tracks(result_data, narrate_dir, title_dur, no_audio)

    # Check inputs: raw video, before shot, after shot
    raw_video = None
    video_info = result_data.get("video")
    if isinstance(video_info, dict) and video_info.get("raw"):
        cand = video_info["raw"]
        if os.path.exists(cand) and os.path.getsize(cand) > 0:
            raw_video = cand

    shots_info = result_data.get("shots") or {}
    before_shot = shots_info.get("before")
    after_shot = shots_info.get("after")
    has_shots = (
        before_shot and os.path.exists(before_shot) and os.path.getsize(before_shot) > 0 and
        after_shot and os.path.exists(after_shot) and os.path.getsize(after_shot) > 0
    )

    # Build FFmpeg command inputs
    cmd_inputs = []
    filter_chains = []
    v_segments = []

    # Title card filter
    status_label = "PASS" if passed else "FAIL"
    status_bg = "0x059669" if passed else "0xdc2626"
    status_fg = "0x34d399" if passed else "0xf87171"
    step_plural = "step" if step_count == 1 else "steps"
    sub_text = f"Tier\\: {tier.upper()}   |   Duration\\: {duration_s:.1f}s   |   {step_count} {step_plural}"

    title_esc_name = escape_ffmpeg_text(check_name)
    sub_text_esc = escape_ffmpeg_text(sub_text)

    filter_chains.append(
        f"color=c=0x0f172a:s=1280x720:d={title_dur:.3f}:r={fps}[t_bg];"
        f"[t_bg]drawtext=fontfile='{font_path}':text='{title_esc_name}':fontsize=42:fontcolor=white:x=(w-text_w)/2:y=230,"
        f"drawbox=x=(w-240)/2:y=330:w=240:h=56:color={status_bg}:t=fill,"
        f"drawtext=fontfile='{font_path}':text='{status_label}':fontsize=32:fontcolor=white:x=(w-text_w)/2:y=342,"
        f"drawtext=fontfile='{font_path}':text='{sub_text_esc}':fontsize=22:fontcolor=0x94a3b8:x=(w-text_w)/2:y=430[t_card]"
    )
    v_segments.append("[t_card]")

    # Screen recording segment
    if raw_video:
        vid_in_idx = len(cmd_inputs) // 2
        cmd_inputs.extend(["-i", raw_video])
        raw_dur = get_media_duration(raw_video)

        scr_filters = [
            f"[{vid_in_idx}:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x0f172a,setpts=PTS-STARTPTS"
        ]

        for i, step in enumerate(steps):
            label = step.get("label") or step.get("id") or f"Step {i+1}"
            step_status = (step.get("status") or "pass").upper()
            start_s = (step.get("startMs", 0) or 0) / 1000.0
            end_s = (step.get("endMs", 0) or (step.get("startMs", 0) + 1000)) / 1000.0
            if start_s >= raw_dur:
                continue
            end_s = max(start_s + 0.5, min(end_s, raw_dur if raw_dur > 0 else end_s))

            caption_label = escape_ffmpeg_text(f"Step {i+1}: {label}")
            step_badge = f"[{step_status}]"
            step_color = "0x34d399" if step_status == "PASS" else ("0xf87171" if step_status == "FAIL" else "0x94a3b8")

            scr_filters.append(
                f"drawbox=enable='between(t,{start_s:.3f},{end_s:.3f})':x=0:y=620:w=1280:h=80:color=0x0f172acc:t=fill"
            )
            scr_filters.append(
                f"drawtext=enable='between(t,{start_s:.3f},{end_s:.3f})':fontfile='{font_path}':text='{caption_label}':fontsize=24:fontcolor=white:x=32:y=646"
            )
            scr_filters.append(
                f"drawtext=enable='between(t,{start_s:.3f},{end_s:.3f})':fontfile='{font_path}':text='{step_badge}':fontsize=24:fontcolor={step_color}:x=w-160:y=646"
            )

        filter_chains.append(",".join(scr_filters) + "[scr_card]")
        v_segments.append("[scr_card]")
    else:
        # Fallback 2s screen card
        fallback_dur = 2.0
        filter_chains.append(
            f"color=c=0x1e293b:s=1280x720:d={fallback_dur:.3f}:r={fps},"
            f"drawtext=fontfile='{font_path}':text='(Screen recording completed)':fontsize=32:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2[scr_fallback]"
        )
        v_segments.append("[scr_fallback]")

    # Before/After comparison segment
    if has_shots:
        before_in_idx = len(cmd_inputs) // 2
        cmd_inputs.extend(["-i", before_shot])
        after_in_idx = len(cmd_inputs) // 2
        cmd_inputs.extend(["-i", after_shot])

        filter_chains.append(
            f"color=c=0x0f172a:s=1280x720:d={shots_dur:.3f}:r={fps}[sh_bg];"
            f"[sh_bg]drawtext=fontfile='{font_path}':text='BEFORE / AFTER COMPARISON':fontsize=32:fontcolor=white:x=(w-text_w)/2:y=40,"
            f"drawtext=fontfile='{font_path}':text='BEFORE':fontsize=24:fontcolor=0x94a3b8:x=300:y=90,"
            f"drawtext=fontfile='{font_path}':text='AFTER':fontsize=24:fontcolor=0x34d399:x=930:y=90[sh_hdr];"
            f"[{before_in_idx}:v]scale=580:400:force_original_aspect_ratio=decrease[b_scaled];"
            f"[{after_in_idx}:v]scale=580:400:force_original_aspect_ratio=decrease[a_scaled];"
            f"[sh_hdr][b_scaled]overlay=x=30+(580-w)/2:y=140+(400-h)/2[sh_tmp];"
            f"[sh_tmp][a_scaled]overlay=x=670+(580-w)/2:y=140+(400-h)/2[shots_card]"
        )
        v_segments.append("[shots_card]")

    # Concatenate visual segments
    concat_inputs = "".join(v_segments)
    filter_chains.append(f"{concat_inputs}concat=n={len(v_segments)}:v=1:a=0[vout]")

    # Audio mixing
    audio_stream_map = []
    if audio_tracks:
        audio_subchains = []
        for track in audio_tracks:
            aud_in_idx = len(cmd_inputs) // 2
            cmd_inputs.extend(["-i", track["path"]])
            delay_ms = int(max(0, track["offset_s"]) * 1000)
            tag = f"a_{track['id']}_{aud_in_idx}"
            filter_chains.append(
                f"[{aud_in_idx}:a]adelay={delay_ms}|{delay_ms},aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[{tag}]"
            )
            audio_subchains.append(f"[{tag}]")

        if len(audio_subchains) == 1:
            filter_chains.append(f"{audio_subchains[0]}aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[aout]")
        else:
            filter_chains.append(
                f"{''.join(audio_subchains)}amix=inputs={len(audio_subchains)}:duration=longest:dropout_transition=0,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[aout]"
            )
        audio_stream_map = ["-map", "[aout]", "-c:a", "aac", "-b:a", "128k"]

    filter_complex_str = ";".join(filter_chains)

    cmd = [
        "ffmpeg",
        "-y",
        *cmd_inputs,
        "-filter_complex",
        filter_complex_str,
        "-map",
        "[vout]",
        *audio_stream_map,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-preset",
        "veryfast",
        "-crf",
        "24",
        out_path,
    ]

    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"FFmpeg fast render failed (code {res.returncode}):\n{res.stderr}")


def render_moviepy(result_data, out_path, narrate_dir, font_path, fps, initial_title_dur, shots_dur, no_audio):
    from moviepy import (
        ColorClip,
        TextClip,
        ImageClip,
        VideoFileClip,
        AudioFileClip,
        CompositeVideoClip,
        CompositeAudioClip,
        concatenate_videoclips,
    )

    check_name = format_title_name(result_data.get("name", "Verification"))
    passed = bool(result_data.get("passed", True))
    tier = str(result_data.get("tier", "daemon"))
    duration_ms = result_data.get("durationMs", 0) or 0
    duration_s = duration_ms / 1000.0
    steps = result_data.get("steps") or []
    step_count = len(steps)

    # Title card
    title_wav = os.path.join(narrate_dir, "title.wav") if narrate_dir else None
    title_dur = initial_title_dur
    if not no_audio and title_wav and os.path.exists(title_wav):
        t_aud_dur = get_media_duration(title_wav)
        if t_aud_dur > 0:
            title_dur = max(initial_title_dur, t_aud_dur + 0.15)

    bg_t = ColorClip(size=(1280, 720), color=(15, 23, 42), duration=title_dur)
    t_name = TextClip(
        text=check_name,
        font=font_path,
        font_size=42,
        color="white",
        text_align="center",
        duration=title_dur,
    ).with_position(("center", 220))

    status_label = "PASS" if passed else "FAIL"
    status_bg_color = (5, 150, 105) if passed else (220, 38, 38)
    badge_bg = ColorClip(size=(240, 56), color=status_bg_color, duration=title_dur).with_position(("center", 330))
    badge_txt = TextClip(
        text=status_label,
        font=font_path,
        font_size=32,
        color="white",
        duration=title_dur,
    ).with_position(("center", 342))

    step_plural = "step" if step_count == 1 else "steps"
    meta_str = f"Tier: {tier.upper()}   |   Duration: {duration_s:.1f}s   |   {step_count} {step_plural}"
    meta_txt = TextClip(
        text=meta_str,
        font=font_path,
        font_size=22,
        color="#94a3b8",
        duration=title_dur,
    ).with_position(("center", 430))

    title_clip = CompositeVideoClip([bg_t, t_name, badge_bg, badge_txt, meta_txt], size=(1280, 720)).with_duration(title_dur)

    clips = [title_clip]

    # Screen recording
    raw_video = None
    video_info = result_data.get("video")
    if isinstance(video_info, dict) and video_info.get("raw"):
        cand = video_info["raw"]
        if os.path.exists(cand) and os.path.getsize(cand) > 0:
            raw_video = cand

    if raw_video:
        scr = VideoFileClip(raw_video)
        if scr.size != (1280, 720):
            scr = scr.resized((1280, 720))
        scr_dur = scr.duration
        overlays = [scr]

        for i, step in enumerate(steps):
            label = step.get("label") or step.get("id") or f"Step {i+1}"
            step_status = (step.get("status") or "pass").upper()
            start_s = (step.get("startMs", 0) or 0) / 1000.0
            end_s = (step.get("endMs", 0) or (step.get("startMs", 0) + 1000)) / 1000.0
            if start_s >= scr_dur:
                continue
            end_s = max(start_s + 0.5, min(end_s, scr_dur if scr_dur > 0 else end_s))
            step_dur = end_s - start_s

            step_color = "#34d399" if step_status == "PASS" else ("#f87171" if step_status == "FAIL" else "#94a3b8")
            banner = (
                ColorClip(size=(1280, 70), color=(15, 23, 42), duration=step_dur)
                .with_opacity(0.85)
                .with_position((0, 630))
                .with_start(start_s)
            )
            txt_label = (
                TextClip(
                    text=f"Step {i+1}: {label}",
                    font=font_path,
                    font_size=24,
                    color="white",
                    duration=step_dur,
                )
                .with_position((32, 650))
                .with_start(start_s)
            )
            txt_badge = (
                TextClip(
                    text=f"[{step_status}]",
                    font=font_path,
                    font_size=24,
                    color=step_color,
                    duration=step_dur,
                )
                .with_position((1120, 650))
                .with_start(start_s)
            )
            overlays.extend([banner, txt_label, txt_badge])

        screen_clip = CompositeVideoClip(overlays, size=(1280, 720)).with_duration(scr_dur)
        clips.append(screen_clip)
    else:
        fallback_dur = 2.0
        bg_fb = ColorClip(size=(1280, 720), color=(30, 41, 59), duration=fallback_dur)
        txt_fb = TextClip(
            text="(Screen recording completed)",
            font=font_path,
            font_size=32,
            color="white",
            duration=fallback_dur,
        ).with_position(("center", "center"))
        clips.append(CompositeVideoClip([bg_fb, txt_fb], size=(1280, 720)).with_duration(fallback_dur))

    # Before / After stills
    shots_info = result_data.get("shots") or {}
    before_shot = shots_info.get("before")
    after_shot = shots_info.get("after")
    if (
        before_shot and os.path.exists(before_shot) and os.path.getsize(before_shot) > 0 and
        after_shot and os.path.exists(after_shot) and os.path.getsize(after_shot) > 0
    ):
        bg_s = ColorClip(size=(1280, 720), color=(15, 23, 42), duration=shots_dur)
        sh_hdr = TextClip(
            text="BEFORE / AFTER COMPARISON",
            font=font_path,
            font_size=32,
            color="white",
            duration=shots_dur,
        ).with_position(("center", 40))
        lbl_b = TextClip(
            text="BEFORE",
            font=font_path,
            font_size=24,
            color="#94a3b8",
            duration=shots_dur,
        ).with_position((270, 95))
        lbl_a = TextClip(
            text="AFTER",
            font=font_path,
            font_size=24,
            color="#34d399",
            duration=shots_dur,
        ).with_position((910, 95))

        img_b = ImageClip(before_shot).resized(width=580)
        if img_b.size[1] > 400:
            img_b = img_b.resized(height=400)
        img_b = (
            img_b.with_duration(shots_dur)
            .with_position((30 + (580 - img_b.size[0]) // 2, 140 + (400 - img_b.size[1]) // 2))
        )

        img_a = ImageClip(after_shot).resized(width=580)
        if img_a.size[1] > 400:
            img_a = img_a.resized(height=400)
        img_a = (
            img_a.with_duration(shots_dur)
            .with_position((670 + (580 - img_a.size[0]) // 2, 140 + (400 - img_a.size[1]) // 2))
        )

        shots_clip = CompositeVideoClip([bg_s, sh_hdr, lbl_b, lbl_a, img_b, img_a], size=(1280, 720)).with_duration(shots_dur)
        clips.append(shots_clip)

    final_video = concatenate_videoclips(clips)

    # Attach Audio
    audio_tracks = collect_audio_tracks(result_data, narrate_dir, title_dur, no_audio)
    if audio_tracks:
        audio_clips = []
        for track in audio_tracks:
            a_clip = AudioFileClip(track["path"]).with_start(max(0, track["offset_s"]))
            audio_clips.append(a_clip)
        audio_comp = CompositeAudioClip(audio_clips)
        final_video = final_video.with_audio(audio_comp)

    final_video.write_videofile(
        out_path,
        fps=fps,
        codec="libx264",
        audio_codec="aac",
        ffmpeg_params=["-pix_fmt", "yuv420p", "-preset", "fast", "-crf", "24"],
        logger=None,
    )


def enforce_max_mb(out_path, max_mb):
    max_bytes = int(max_mb * 1024 * 1024)
    if not os.path.exists(out_path):
        raise RuntimeError(f"Output file does not exist: {out_path}")

    current_bytes = os.path.getsize(out_path)
    if current_bytes <= max_bytes:
        return current_bytes

    print(f"[video] Output size {current_bytes} bytes exceeds {max_mb} MB ({max_bytes} bytes). Re-encoding to compress...", file=sys.stderr)

    tmp_fd, tmp_target = tempfile.mkstemp(suffix=".mp4")
    os.close(tmp_fd)

    reencode_attempts = [
        # Pass 1: Higher CRF, lower audio bitrate
        ["ffmpeg", "-y", "-i", out_path, "-c:v", "libx264", "-crf", "30", "-preset", "fast", "-c:a", "aac", "-b:a", "96k", "-pix_fmt", "yuv420p", tmp_target],
        # Pass 2: Scale to 960x540, CRF 32
        ["ffmpeg", "-y", "-i", out_path, "-vf", "scale=960:540", "-c:v", "libx264", "-crf", "32", "-preset", "fast", "-c:a", "aac", "-b:a", "64k", "-pix_fmt", "yuv420p", tmp_target],
        # Pass 3: Scale to 640x360, CRF 36
        ["ffmpeg", "-y", "-i", out_path, "-vf", "scale=640:360", "-c:v", "libx264", "-crf", "36", "-preset", "fast", "-c:a", "aac", "-b:a", "48k", "-pix_fmt", "yuv420p", tmp_target],
    ]

    for i, cmd in enumerate(reencode_attempts, 1):
        res = subprocess.run(cmd, capture_output=True, text=True)
        if res.returncode == 0 and os.path.exists(tmp_target):
            sz = os.path.getsize(tmp_target)
            if sz <= max_bytes:
                shutil.move(tmp_target, out_path)
                print(f"[video] Compression pass {i} succeeded: size reduced to {sz} bytes (<= {max_bytes} bytes)", file=sys.stderr)
                return sz

    if os.path.exists(tmp_target):
        sz = os.path.getsize(tmp_target)
        if sz < current_bytes:
            shutil.move(tmp_target, out_path)
            current_bytes = sz
        else:
            os.unlink(tmp_target)

    raise RuntimeError(
        f"Failed to fit video within {max_mb} MB limit: current size is {current_bytes} bytes (cap {max_bytes} bytes)"
    )


def main():
    args = parse_args()
    abs_result = os.path.abspath(args.result)
    abs_out = os.path.abspath(args.out)

    if not os.path.exists(abs_result):
        print(f"error: result file not found at {abs_result}", file=sys.stderr)
        sys.exit(1)

    os.makedirs(os.path.dirname(abs_out), exist_ok=True)

    with open(abs_result, "r", encoding="utf-8") as f:
        result_data = json.load(f)

    font_path = resolve_font(args.font)
    narrate_dir = os.path.abspath(args.narrate_dir) if args.narrate_dir else None

    t0 = time.perf_counter()
    if args.fast:
        render_fast_ffmpeg(
            result_data=result_data,
            out_path=abs_out,
            narrate_dir=narrate_dir,
            font_path=font_path,
            fps=args.fps,
            initial_title_dur=args.title_dur,
            shots_dur=args.shots_dur,
            no_audio=args.no_audio,
        )
    else:
        render_moviepy(
            result_data=result_data,
            out_path=abs_out,
            narrate_dir=narrate_dir,
            font_path=font_path,
            fps=args.fps,
            initial_title_dur=args.title_dur,
            shots_dur=args.shots_dur,
            no_audio=args.no_audio,
        )

    final_bytes = enforce_max_mb(abs_out, args.max_mb)
    final_duration = get_media_duration(abs_out)
    wall_ms = (time.perf_counter() - t0) * 1000.0

    print(f"[video] Finished video assembly ({'fast' if args.fast else 'moviepy'}) in {wall_ms:.1f}ms", file=sys.stderr)

    # JSON contract on the very last line
    output_summary = {
        "out": abs_out,
        "bytes": final_bytes,
        "durationSec": round(final_duration, 2),
    }
    print(json.dumps(output_summary))


if __name__ == "__main__":
    main()
