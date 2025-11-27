import cp from "node:child_process";
import fs, { existsSync } from "node:fs";
import { unlink, readdir, stat } from "node:fs/promises";
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
// Current solution: Write to HLS/m3u8 and treat as a live stream
// Set up TOTP to verify subscribers if needed

fs.mkdirSync("/tmp/convert", { recursive: true });
const key = process.env.SSL_KEY_FILE
  ? fs.readFileSync(process.env.SSL_KEY_FILE).toString()
  : "";
const cert = process.env.SSL_CRT_FILE
  ? fs.readFileSync(process.env.SSL_CRT_FILE).toString()
  : "";
const port = Number(process.env.PORT) || 80;
const server =
  key && cert ? http2.createSecureServer({ key, cert }) : http2.createServer();
const basePath = "/tmp/convert";

server.listen(port);

const x264 = [
  "-filter:v",
  "fps=fps=30,scale='min(iw, 1920)':-1",
  "-c:v",
  "libx264",
  "-preset",
  "veryfast",
  "-x264-params",
  '"keyint=30:scenecut=0"',
  "-crf",
  "26",
  "-c:a",
  "aac",
  "-ac",
  "2",
  "-g",
  "60",
];

const opts1 = ["-re", "-i", "pipe:", ...x264, "-f", "mpegts", "-"];

const opts2 = (id: string) => [
  "-i",
  "pipe:",
  ...x264,
  "-f",
  "mp4",
  "-movflags",
  "frag_keyframe+empty_moov+faststart",
  basePath + id,
];

const opts3 = (id: string) => [
  // -re causes conversion to happen at playback speed
  // If we want to convert as fast as possible, disable it
  // "-re",
  "-i",
  "pipe:",
  ...x264,
  "-f",
  "hls",
  "-hls_list_size",
  "0",
  basePath + id,
];

const rooms = new Map<string, cp.ChildProcessWithoutNullStreams>();
server.on("stream", async (stream, headers) => {
  try {
    const url = new URL("http://localhost" + (headers[":path"] ?? ""));
    const id = url.pathname;
    console.log(headers[":method"], id);
    let outHeaders: http2.OutgoingHttpHeaders = {
      "access-control-allow-origin": "*",
    };
    if (headers[":method"] == "OPTIONS") {
      stream.respond(outHeaders);
      stream.end();
    } else if (headers[":method"] === "POST") {
      // Publisher
      if (!rooms.get(id)) {
        let opts = opts3(id);
        if (id.endsWith(".mpegts")) {
          opts = opts1;
        }
        let ffmpeg: cp.ChildProcessWithoutNullStreams | null = cp.spawn(
          "ffmpeg",
          opts,
        );
        rooms.set(id, ffmpeg);
        console.log(id, ffmpeg);
        ffmpeg.stderr.on("data", (data) => {
          console.log(data.toString());
          // Would be nice to send this to the client as a stream but right now fetch buffers the entire response
          // stream.write(data.toString());
        });
        stream.respond(outHeaders);
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
    } else if (id.endsWith(".mpegts") && headers[":method"] === "GET") {
      // Reader
      let ffmpeg = rooms.get(id);
      // Wait for room to be available if it's not
      while (!ffmpeg) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        ffmpeg = rooms.get(id);
      }
      stream.respond(outHeaders);
      await pipeline(ffmpeg.stdout, stream);
    } else if (headers[":method"] === "GET") {
      // Serve static file from /tmp
      if (id.endsWith(".m3u8")) {
        outHeaders["content-type"] = "application/vnd.apple.mpegurl";
        outHeaders["cache-control"] = "no-cache";
      } else if (id.endsWith(".ts")) {
        outHeaders["content-type"] = "video/mp2t";
      }
      try {
        const fileStream = fs.createReadStream(basePath + id);
        stream.respond(outHeaders);
        await pipeline(fileStream, stream);
      } catch (e: any) {
        if (e.code === "ENOENT" && !stream.headersSent) {
          stream.respond({ ":status": 404, ...outHeaders });
          stream.end();
        } else {
          throw e;
        }
      }
    } else {
      stream.respond({ ":status": 404, ...outHeaders });
      stream.end();
    }
  } catch (e: any) {
    console.error(e);
    if (stream.writable) {
      stream.respond({ ":status": 500 });
      stream.end("error");
    }
  }
});

// Background process to clean up tmp files
setInterval(
  async () => {
    try {
      const files = await readdir(basePath);
      for (let file of files) {
        try {
          const filePath = basePath + "/" + file;
          if (
            Date.now() - (await stat(filePath)).birthtimeMs >
            6 * 60 * 60 * 1000
          ) {
            console.log("deleting " + file);
            await unlink(filePath);
          }
        } catch (e) {
          console.error(e);
        }
      }
    } catch (e) {
      console.error(e);
    }
  },
  60 * 60 * 1000,
);
