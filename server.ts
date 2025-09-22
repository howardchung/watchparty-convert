import 'dotenv/config';
import Fastify, { type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import cp from 'node:child_process';
import fs from 'node:fs';

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
const rooms = new Map<string, Map<string, FastifyReply>>();
const fastify = Fastify({ http2: true, https: { key, cert }, logger: true });
await fastify.register(cors, {
  origin: '*',
});

fastify.post('/:id', (req, res) => {
  const id = (req.params as any).id;
  const room = new Map<string, FastifyReply>();
  rooms.set(id, room);
  console.log('upload', id);
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
    'mpegts',
    '-',
  ]);
  ffmpeg.stdout.on('data', (data) => {
    // Write chunk to any connected consumers by consulting map/id
    for (let res of room.values()) {
      res.raw.write(data);
    }
  });
  ffmpeg.stderr.on('data', (data) => {
    console.log(data.toString());
  });
  const handleClose = () => {
    console.log('upload close');
    ffmpeg?.kill();
    ffmpeg = null;
    rooms.delete(id);
    res.send();
  };
  req.raw.pipe(ffmpeg.stdin).once('error', handleClose);
  req.raw.once('close', handleClose);
});
fastify.get('/:id', (req, res) => {
  const id = (req.params as any).id.replace('.ts', '');
  console.log('download', id);
  const room = rooms.get(id);
  if (!room) {
    return res.status(404).send();
  }
  res.raw.setHeader('access-control-allow-origin', '*');
  const rand = String(Math.random());
  // Add res to the map of connected clients for this id
  //@ts-expect-error
  room.set(rand, res);
  console.log(room);
  // On end/close, remove res from map
  req.raw.once('close', () => {
    room.delete(rand);
    res.send();
  });
});

const port = Number(process.env.PORT) ?? 80;
await fastify.listen({ port, host: '0.0.0.0' });
// console.log('listening', port);
