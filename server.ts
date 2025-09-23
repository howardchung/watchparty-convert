import 'dotenv/config';
import cp from 'node:child_process';
import fs from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import http from 'node:http';
import https from 'node:https';
import express from 'express';

// http server (or express?)
// client generates uuid on upload to /upload/:id endpoint
// server creates ffmpeg child process and pipes stream
// Convert to h264/aac, use -re option to convert at playback rate
// output to mpegts
// write output chunks to any clients connected to /download/:id.ts
// clients can join at any point in the stream
// Add CORS header
// client sets url to /download/:id.ts
// mpegts.js on client to play ts stream
// on client disconnect, kill child process
// could accept screenshare or fileshare input?
// fileshare: directly upload chunks reading from user's file
// screenshare: upload video data from getDisplayMedia function (vp8 input?)
// mpegts cons: currently kind of complicated to pause, because video keeps uploading and streaming in the background
// maybe need to pause the upload if that happens?
// new joiners will only get the latest packets so will be out of sync with already present paused viewers
// alternative: write output to a mp4 file, and serve static http file
// however then we need to manage cleanup of the file
const key = process.env.SSL_KEY_FILE
  ? fs.readFileSync(process.env.SSL_KEY_FILE).toString()
  : '';
const cert = process.env.SSL_CRT_FILE
  ? fs.readFileSync(process.env.SSL_CRT_FILE).toString()
  : '';
const rooms = new Map<string, Map<string, WebSocket>>();
const port = Number(process.env.PORT) || 80;
const app = express();
const server = (key && cert) ? https.createServer({ key, cert }, app) : http.createServer(app);
const wss = new WebSocketServer({ server });
server.listen(port);

app.get('/:id', (req, res) => {
  const id = req.params.id;
  console.log(id);
  const { range } = req.headers;
  let streamOptions = undefined;
  let { size: fileSize } = fs.statSync('/tmp/' + id);
  if (range) {
    const [s, e] = range.replace("bytes=", "").split("-");
    const start = Number(s);
    const end = Number(e) || fileSize - 1;
    streamOptions = { start, end };
    res.append("Accept-Ranges", "bytes");
    res.append("Content-Range", `bytes ${start}-${end}/${fileSize}`);
    res.append("Content-Length", String(end - start + 1));
    res.status(206);
  } else {
    res.append("Content-Length", String(fileSize));
  }
  res.append('Access-Control-Allow-Origin', '*');
  res.append("Content-Type", "video/mp4");
  const fileStream = fs.createReadStream('/tmp/' + id, streamOptions);
  fileStream.pipe(res);
});

wss.on('connection', (ws, req) => {
  console.log(req.url);
  const id = req.url?.split('/').slice(-1)[0];
  if (!id) {
    console.log('no id');
    return;
  }
  if (!rooms.has(id)) {
    // Publisher
    const room = new Map<string, WebSocket>();
    rooms.set(id, room);
    // ws.send('wss://azure.howardchung.net:5001/' + id);
    // let ffmpeg: cp.ChildProcessWithoutNullStreams | null = cp.spawn('ffmpeg', [
    //   '-re',
    //   '-i',
    //   'pipe:',
    //   '-c:v',
    //   'libx264',
    //   '-preset',
    //   'veryfast',
    //   '-c:a',
    //   'aac',
    //   '-ac',
    //   '2',
    //   '-f',
    //   'mpegts',
    //   '-',
    // ]);
    // let ffmpeg: cp.ChildProcessWithoutNullStreams | null = cp.spawn('ffmpeg', [
    //   '-i',
    //   'pipe:',
    //   '-c:v',
    //   'libx264',
    //   '-preset',
    //   'veryfast',
    //   '-c:a',
    //   'aac',
    //   '-ac',
    //   '2',
    //   '-f',
    //   'mp4',
    //   '-movflags',
    //   'frag_keyframe+empty_moov+faststart',
    //   '/tmp/' + id,
    // ]);
    let ffmpeg: cp.ChildProcessWithoutNullStreams | null = cp.spawn('ffmpeg', [
      '-re',
      '-i',
      'pipe:',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-c:a',
      'aac',
      '-ac',
      '2',
      '-f',
      'hls',
      '/tmp/' + id + '.m3u8',
    ]);
    let urlSent = false;
    ws.on('message', (data) => {
      const sendNext = ffmpeg?.stdin.write(data);
      if (sendNext) {
        ws.send('1');
      } else {
        ffmpeg?.stdin.once('drain', () => {
          ws.send('1');
        });
      }
    });
    ffmpeg.stdout.on('data', (data) => {
      // Write chunk to any connected consumers by consulting map/id
      for (let res of room.values()) {
        res.send(data);
      }
    });
    ffmpeg.stderr.on('data', (data) => {
      console.log(data.toString());
      if (data.toString().includes(`${id}.m3u8.tmp`) && !urlSent) {
        ws.send('https://azure.howardchung.net:5001/' + id + '.m3u8');
        urlSent = true;
      }
    });
    const handleClose = () => {
      console.log('upload close');
      ffmpeg?.kill();
      ffmpeg = null;
      rooms.delete(id);
    };
    ws.once('close', handleClose);
    ws.once('error', handleClose);
  } else {
    // Subscriber
    const room = rooms.get(id);
    const rand = String(Math.random());
    room?.set(rand, ws);
    ws.once('close', () => {
      room?.delete(rand);
    });
  }
});