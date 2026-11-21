import assert from 'node:assert/strict';
import test from 'node:test';
import { videoThumbnailRange } from '../app/utils/videoThumbnail.ts';
import { captureFileName, dataUrlToFile, showMediaUrl, showRelativePath } from '../app/utils/stillCapture.ts';

const png = 'data:image/png;base64,' + Buffer.from('slide').toString('base64');
const jpeg = 'data:image/jpeg;base64,' + Buffer.from('photo').toString('base64');

test('a captured picture becomes a file with its own bytes and type', async () => {
  const file = dataUrlToFile(png, 'Capture.png');
  assert.equal(file.name, 'Capture.png');
  assert.equal(file.type, 'image/png');
  assert.equal(Buffer.from(await file.arrayBuffer()).toString(), 'slide');
  assert.equal(dataUrlToFile(jpeg, 'c.jpg').type, 'image/jpeg');
  assert.throws(() => dataUrlToFile('data:text/html;base64,PGI+', 'x.html'), /could not be read/);
  assert.throws(() => dataUrlToFile('https://example.invalid/picture.png', 'x.png'), /could not be read/);
});

test('each capture gets its own readable, safe file name', () => {
  const at = new Date(2026, 10, 16, 9, 5, 7);
  assert.equal(captureFileName('Walk-in music', at, png), 'Capture - Walk-in music - 2026-11-16 09.05.07.png');
  assert.equal(captureFileName('Standby', at, jpeg), 'Capture - Standby - 2026-11-16 09.05.07.jpg');
  assert.equal(captureFileName('Act 2: "Finale" / reprise?', at, png), 'Capture - Act 2 Finale reprise - 2026-11-16 09.05.07.png');
  assert.equal(captureFileName('   ', at, png), 'Capture - Standby - 2026-11-16 09.05.07.png');
  assert.equal(captureFileName('x'.repeat(200), at, png).length, 'Capture -  - 2026-11-16 09.05.07.png'.length + 48);
  assert.equal(captureFileName('Ends with dots...', at, png), 'Capture - Ends with dots - 2026-11-16 09.05.07.png');
  // A second later is another file: the earlier capture is still there for Undo.
  assert.notEqual(captureFileName('Cue', at, png), captureFileName('Cue', new Date(at.getTime() + 1000), png));
});

test('a picture in the show folder is stored relative to it', () => {
  assert.equal(showRelativePath('/shows/Gala', '/shows/Gala/media/Capture.png'), 'media/Capture.png');
  assert.equal(showRelativePath('C:\\Shows\\Gala', 'C:\\Shows\\Gala\\media\\Capture.png'), 'media/Capture.png');
  assert.equal(showRelativePath('/shows/Gala', '/elsewhere/Capture.png'), '/elsewhere/Capture.png');
  assert.equal(showRelativePath(undefined, '/elsewhere/Capture.png'), '/elsewhere/Capture.png');
});

test('a thumbnail is asked for from the engine by the picture\'s full path', () => {
  const url = new URL(showMediaUrl('http://127.0.0.1:4480/', 'tok en', '/shows/Gala/', 'media/Capture 1.png')!);
  assert.equal(url.origin + url.pathname, 'http://127.0.0.1:4480/api/media');
  assert.equal(url.searchParams.get('path'), '/shows/Gala/media/Capture 1.png');
  assert.equal(url.searchParams.get('access_token'), 'tok en');
  assert.equal(new URL(showMediaUrl('http://h', '', '/shows', 'C:\\pics\\a.png')!).searchParams.get('path'), 'C:\\pics\\a.png');
  assert.equal(new URL(showMediaUrl('http://h', null, null, '/abs/a.png')!).searchParams.has('access_token'), false);
  assert.equal(showMediaUrl('http://h', '', null, 'media/a.png'), null);
  assert.equal(showMediaUrl('http://h', '', '/shows', null), null);
  assert.equal(showMediaUrl('', '', '/shows', 'media/a.png'), null);
});

test('a video thumbnail defaults to the trimmed midpoint and keeps a valid saved choice', () => {
  assert.deepEqual(videoThumbnailRange({ inPoint: 2, outPoint: 8 }, 10),
    { start: 2, end: 7.999, middle: 5, time: 5 });
  assert.equal(videoThumbnailRange({ inPoint: 2, outPoint: 8, videoThumbnailTime: 3 }, 10).time, 3);
  assert.equal(videoThumbnailRange({ inPoint: 4, outPoint: 8, videoThumbnailTime: 3 }, 10).time, 4);
  assert.equal(videoThumbnailRange({ inPoint: 0, outPoint: 0, videoThumbnailTime: null }, 10).time, 5);
  assert.equal(videoThumbnailRange({ inPoint: 0, outPoint: 8, videoThumbnailTime: 12 }, 6).time, 5.999);
});
