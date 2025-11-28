import cp from "node:child_process";
import fs from "node:fs";
import { unlink, readdir, stat } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { pipeline } from "node:stream/promises";
import { createWebSocketStream, WebSocketServer } from "ws";

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

const key = process.env.SSL_KEY_FILE
  ? fs.readFileSync(process.env.SSL_KEY_FILE).toString()
  : "";
const cert = process.env.SSL_CRT_FILE
  ? fs.readFileSync(process.env.SSL_CRT_FILE).toString()
  : "";
const port = Number(process.env.PORT) || 80;
const server =
  key && cert ? https.createServer({ key, cert }) : http.createServer();
const basePath = "/tmp/convert";

server.listen(port, () => {
  console.log("listening on %s", port);
});
const wss = new WebSocketServer({ server });

fs.mkdirSync("/tmp/convert", { recursive: true });

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

wss.on("connection", async (ws, req) => {
  // Upload
  ws.once("close", handleClose);
  ws.once("error", handleClose);
  const url = new URL("http://localhost" + (req.url ?? ""));
  const id = url.pathname;
  let opts = opts3(id);
  if (id.endsWith(".mpegts")) {
    opts = opts1;
  }
  let ffmpeg: cp.ChildProcessWithoutNullStreams = cp.spawn("ffmpeg", opts);
  ffmpeg.stderr.on("data", (data) => {
    console.log(data.toString());
  });

  const duplex = createWebSocketStream(ws);
  ws.send(1);
  duplex.on("data", () => {
    // Got a chunk, request the next one
    if (ws.readyState === ws.OPEN) {
      ws.send(1);
    }
  });
  try {
    await pipeline(duplex, ffmpeg.stdin);
  } catch (e) {
    handleClose(e);
  }

  function handleClose(e?: any) {
    console.error(e);
    ws.close();
    ffmpeg.kill();
  }
});

server.on("request", async (req, res) => {
  const url = new URL("http://localhost" + (req.url ?? ""));
  const id = url.pathname;
  console.log(req.method, id);
  let outHeaders: Record<string, string> = {
    "access-control-allow-origin": "*",
  };
  res.setHeaders(new Headers(outHeaders));
  if (req.method === "GET") {
    // Serve static file from /tmp
    try {
      // Check if file exists since createReadStream always succeeds
      await stat(basePath + id);
    } catch (e: any) {
      if (e.code === "ENOENT") {
        res.statusCode = 404;
        res.end("not found");
        return;
      } else {
        throw e;
      }
    }
    if (id.endsWith(".m3u8")) {
      outHeaders["content-type"] = "application/vnd.apple.mpegurl";
      outHeaders["cache-control"] = "no-cache";
    } else if (id.endsWith(".ts")) {
      outHeaders["content-type"] = "video/mp2t";
    }
    const fileStream = fs.createReadStream(basePath + id);
    res.setHeaders(new Headers(outHeaders));
    try {
      await pipeline(fileStream, res);
    } catch (e) {
      handleError(e);
    }
  } else {
    res.statusCode = 404;
    res.end("not found");
  }
  function handleError(e: any) {
    console.error(e);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end("error");
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
