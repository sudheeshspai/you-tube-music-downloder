const { spawn } = require('child_process');

function fetchYtDlpInfo(url) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', ['--dump-json', '--no-playlist', '--no-warnings', url]);
    let output = '';
    let errorOutput = '';

    proc.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      errorOutput += chunk.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        console.log("Success!");
      } else {
        console.error('yt-dlp error: ' + errorOutput);
      }
    });
  });
}

fetchYtDlpInfo('https://youtu.be/jNQXAC9IVRw');
