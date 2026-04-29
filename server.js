const express = require("express");
const multer = require("multer");
const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");

const app = express();
const upload = multer({ dest: "tmp/" });

/* =========================
   🎬 IMAGE + AUDIO → VIDEO
========================= */
app.post("/image-audio-to-video", upload.fields([
  { name: "image" },
  { name: "audio" }
]), async (req, res) => {

  const image = req.files.image[0].path;
  const audio = req.files.audio[0].path;
  const effect = req.body.effect || "0";

  const output = `tmp/output_${Date.now()}.mp4`;

  let vf = null;

  // 🎬 EFFECT 0 — limpio
  if (effect === "0") {
    vf = null;
  }

  // 🎬 EFFECT 1 — zoom suave (Ken Burns)
  if (effect === "1") {
    vf = "zoompan=z='min(zoom+0.0008,1.15)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)',scale=1920:1080:force_original_aspect_ratio=cover";
  }

  // 🎬 EFFECT 2 — cinematic YouTube (RECOMENDADO)
  if (effect === "2") {
    vf = "zoompan=z='min(zoom+0.0012,1.2)':d=1,fade=t=in:st=0:d=1,fade=t=out:st=999:d=1,scale=1920:1080:force_original_aspect_ratio=cover";
  }

  const args = [
    "-y",
    "-loop", "1",
    "-i", image,
    "-i", audio,
  ];

  if (vf) {
    args.push("-vf", vf);
  }

  args.push(
    "-r", "30",
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "18",
    "-pix_fmt", "yuv420p",

    "-c:a", "aac",
    "-b:a", "192k",
    "-af", "loudnorm=I=-14:TP=-1.5:LRA=11",

    "-shortest",
    "-movflags", "+faststart",
    output
  );

  execFile("ffmpeg", args, (err) => {
    if (err) return res.status(500).send(err.message);

    res.sendFile(path.resolve(output));
  });

});


/* =========================
   🎬 MERGE VIDEOS (YOUTUBE SAFE)
========================= */
app.post("/merge-videos", upload.any(), async (req, res) => {

  const files = req.files.filter(f => f.fieldname === "videos");
  const output = `tmp/merged_${Date.now()}.mp4`;

  if (!files || files.length < 2) {
    return res.status(400).send("Se necesitan al menos 2 videos");
  }

  const listPath = `tmp/list_${Date.now()}.txt`;

  const listContent = files
    .map(f => `file '${f.path}'`)
    .join("\n");

  fs.writeFileSync(listPath, listContent);

  const args = [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,

    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "18",

    "-c:a", "aac",
    "-b:a", "192k",

    "-r", "30",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",

    output
  ];

  execFile("ffmpeg", args, (err) => {
    if (err) return res.status(500).send(err.message);

    res.sendFile(path.resolve(output));
  });

});


app.listen(3000, () => {
  console.log("FFmpeg API running on port 3000");
});
