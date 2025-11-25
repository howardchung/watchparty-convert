import cp from "node:child_process";
import fs from "node:fs";
import http2 from "node:http2";
import { pipeline } from "node:stream/promises";

// http/http2 server
// http2 allows request streaming (https://developer.chrome.com/docs/capabilities/web-apis/fetch-streaming-requests)
// client generates uuid on upload to POST endpoint
// server creates ffmpeg child process and pipes stream
// Convert to h264/aac, use -re option to convert at playback rate
// output to mpegts (allows joining midstream)
// write output chunks to any clients connected to GET endpoint
// Add CORS header
// mpegts.js on client to play ts stream
// on client disconnect, kill child process
// could accept screenshare or fileshare input?
// fileshare: directly upload chunks reading from user's file
// screenshare: upload video data from getDisplayMedia function (vp8 input?)
// mpegts cons: currently kind of complicated to pause/seek, because video keeps uploading and streaming in the background
// maybe need to pause the upload if that happens?
// new joiners will only get the latest packets so will be out of sync with already present paused viewers
// seeking is hard because we don't keep the entire file
// alternative: write output to a mp4 file, and serve static http file
// however then we need to manage cleanup of the file

const key = process.env.SSL_KEY_FILE
  ? fs.readFileSync(process.env.SSL_KEY_FILE).toString()
  : "";
const cert = process.env.SSL_CRT_FILE
  ? fs.readFileSync(process.env.SSL_CRT_FILE).toString()
  : "";
const port = Number(process.env.PORT) || 80;
const server = http2.createSecureServer({ key, cert });
server.listen(port);

const opts1 = [
  "-re",
  "-i",
  "pipe:",
  "-c:v",
  "libx264",
  "-preset",
  "veryfast",
  "-c:a",
  "aac",
  "-ac",
  "2",
  "-f",
  "mpegts",
  "-",
];

const opts2 = (id: string) => [
  "-i",
  "pipe:",
  "-c:v",
  "libx264",
  "-preset",
  "veryfast",
  "-c:a",
  "aac",
  "-ac",
  "2",
  "-f",
  "mp4",
  "-movflags",
  "frag_keyframe+empty_moov+faststart",
  "/tmp/" + id,
];

const opts3 = (id: string) => [
  "-re",
  "-i",
  "pipe:",
  "-c:v",
  "libx264",
  "-preset",
  "veryfast",
  "-c:a",
  "aac",
  "-ac",
  "2",
  "-f",
  "hls",
  "/tmp/" + id + ".m3u8",
];

const rooms = new Map<string, cp.ChildProcessWithoutNullStreams>();
server.on("stream", async (stream, headers) => {
  try {
    console.log(headers[":method"]);
    stream.respond({
      "access-control-allow-origin": '*',
    });
    if (headers[":method"] === "POST") {
      // Publisher
      const id = headers[":path"] ?? "";
      if (!rooms.get(id)) {
        let ffmpeg: cp.ChildProcessWithoutNullStreams | null = cp.spawn(
          "ffmpeg",
          opts1,
        );
        rooms.set(id, ffmpeg);
        console.log(id, ffmpeg);
        ffmpeg.stderr.on('data', (data) => {
          console.log(data.toString());
        });
        try {
          await pipeline(stream, ffmpeg.stdin);
        } catch (e) {
          console.log(e);
        }
        // clean up room when stream is done (complete or error)
        console.log("upload ended, cleaning up");
        ffmpeg.kill();
        rooms.delete(id);
      }
    } else if (headers[":method"] === 'GET') {
      // Reader
      const id = headers[":path"] ?? "";
      let ffmpeg = rooms.get(id);
      // Wait for room to be available if it's not
      while (!ffmpeg) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        ffmpeg = rooms.get(id);
        if (!stream.writable) {
          // Client disconnected before we initialized
          return;
        }
      }
      await pipeline(ffmpeg.stdout, stream);
    } else {
      stream.end();
    }
  } catch(e) {
    console.error(e);
    if (stream.writable) {
      stream.respond({ ':status': 500 });
      stream.end('error');
    }
  }
});
