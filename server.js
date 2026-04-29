const express = require("express");
const multer = require("multer");
const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");

const app = express();
const upload = multer({ dest: "tmp/" });

app.post("/image-audio-to-video", upload.fields([
  { name: "image" },
  { name: "audio" }
]), async (req, res) => {

  const image = req.files.image[0].path;
  const audio = req.files.audio[0].path;
  const effect = req.body.effect || "0";

  const output = `tmp/output_${Date.now()}.mp4`;

  let videoFilter = "";

  // 🎬 EFFECT 0: sin efecto
  if (effect === "0") {
    videoFilter = "";
  }

  // 🎬 EFFECT 1: zoom lento (Ken Burns)
  if (effect === "1") {
    videoFilter = "-vf \"zoompan=z='1.0+0.0015*on':d=125\"";
  }

  // 🎬 EFFECT 2: zoom + fade cinematic
  if (effect === "2") {
    videoFilter = "-vf \"zoompan=z='1.0+0.0015*on':d=125,fade=t=in:st=0:d=1,fade=t=out:st=999:d=1\"";
  }

  const cmd = `
ffmpeg -y -loop 1 -i ${image} -i ${audio} \
${videoFilter} \
-c:v libx264 -tune stillimage \
-c:a aac -b:a 192k \
-shortest -pix_fmt yuv420p ${output}
`;

  exec(cmd, (err) => {
    if (err) return res.status(500).send(err.message);

    res.sendFile(path.resolve(output));
  });

});

app.listen(3000, () => {
  console.log("FFmpeg API running on port 3000");
});
