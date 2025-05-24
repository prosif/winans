const fs = require('fs');
const os = require('os');
const path = require('path');

// File type extensions
const AUDIO_EXT = ['.mp3', '.wav', '.aac', '.flac', '.ogg', '.m4a'];
const VIDEO_EXT = ['.mp4', '.avi', '.mov', '.mkv', '.wmv', '.flv', '.webm'];
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.webp'];
const DOC_EXT = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md', '.rtf', '.odt'];

// Helper to get local volumes (cross-platform)
function getVolumes() {
  const platform = os.platform();
  if (platform === 'darwin') {
    return fs.readdirSync('/Volumes').map(name => path.join('/Volumes', name));
  } else if (platform === 'linux') {
    const media = '/media/' + os.userInfo().username;
    if (fs.existsSync(media)) {
      return fs.readdirSync(media).map(name => path.join(media, name));
    }
    return ['/'];
  } else if (platform === 'win32') {
    const drives = [];
    for (let i = 67; i <= 90; i++) { // C: to Z:
      const drive = String.fromCharCode(i) + ':\\';
      if (fs.existsSync(drive)) drives.push(drive);
    }
    return drives;
  }
  return ['/'];
}

// Helper to get free space (in bytes) for a volume
function getFreeSpace(volume) {
  try {
    // Use statvfs on Unix, fs.statSync fallback for Windows
    if (os.platform() === 'win32') {
      // On Windows, use fs.statvfsSync if available, else skip
      // (For demo, just return 1TB)
      return 1 * 1024 * 1024 * 1024 * 1024;
    } else {
      const stat = fs.statSync(volume);
      if (stat && stat.dev) {
        // Use 'df' command for Unix
        const df = require('child_process').execSync(`df -k '${volume.replace(/'/g, "'\\''")}'`).toString();
        const lines = df.split('\n');
        if (lines.length > 1) {
          const parts = lines[1].split(/\s+/);
          if (parts.length > 3) {
            return parseInt(parts[3], 10) * 1024; // available in bytes
          }
        }
      }
    }
  } catch (e) {}
  return 0;
}

// UI State
let state = {
  screen: 'main', // main, analyzing, copy, confirm, progress
  source: null,
  destination: null,
  destFolder: null,
  filesToCopy: [],
  copyProgress: 0,
  analyze: {
    running: false,
    done: false,
    audio: 0,
    video: 0,
    image: 0,
    doc: 0,
    other: 0,
    total: 0,
    size: 0,
    files: []
  }
};

function render() {
  const app = document.getElementById('app');
  app.innerHTML = '';
  if (state.screen === 'main') {
    renderMainScreen(app);
  } else if (state.screen === 'analyzing') {
    renderAnalyzingScreen(app);
  } else if (state.screen === 'copy') {
    renderCopyScreen(app);
  } else if (state.screen === 'confirm') {
    renderConfirmScreen(app);
  } else if (state.screen === 'progress') {
    renderProgressScreen(app);
  }
}

function renderMainScreen(app) {
  const title = document.createElement('h2');
  title.textContent = 'Select Source Volume';
  app.appendChild(title);

  const list = document.createElement('div');
  list.className = 'list';
  getVolumes().forEach(volume => {
    const item = document.createElement('div');
    item.className = 'list-item';
    item.textContent = volume;
    item.onclick = () => {
      state.source = volume;
      state.screen = 'analyzing';
      state.analyze = {
        running: true,
        done: false,
        audio: 0,
        video: 0,
        image: 0,
        doc: 0,
        other: 0,
        total: 0,
        size: 0,
        files: []
      };
      render();
      startAnalyzing(volume);
    };
    list.appendChild(item);
  });
  app.appendChild(list);
}

function renderAnalyzingScreen(app) {
  const title = document.createElement('h2');
  title.textContent = state.analyze.done ? 'Files to copy' : 'Analyzing Volume...';
  app.appendChild(title);

  // Breakdown for 'other' file types
  let otherBreakdown = '';
  if (state.analyze.done && state.analyze.other > 0) {
    const extCounts = {};
    for (const file of state.analyze.files) {
      const ext = path.extname(file).toLowerCase();
      if (
        !AUDIO_EXT.includes(ext) &&
        !VIDEO_EXT.includes(ext) &&
        !IMAGE_EXT.includes(ext) &&
        !DOC_EXT.includes(ext)
      ) {
        extCounts[ext || '(no ext)'] = (extCounts[ext || '(no ext)'] || 0) + 1;
      }
    }
    otherBreakdown = '<ul style="margin:0 0 0 20px;">';
    for (const ext in extCounts) {
      otherBreakdown += `<li>${ext}: <b>${extCounts[ext]}</b></li>`;
    }
    otherBreakdown += '</ul>';
  }

  const progress = document.createElement('div');
  progress.innerHTML = `
    <p>Audio: <b>${state.analyze.audio}</b></p>
    <p>Video: <b>${state.analyze.video}</b></p>
    <p>Images: <b>${state.analyze.image}</b></p>
    <p>Documents: <b>${state.analyze.doc}</b></p>
    <p>Other: <b>${state.analyze.other}</b>${otherBreakdown}</p>
    <p>Total files: <b>${state.analyze.total}</b></p>
    <p>Total size: <b>${formatBytes(state.analyze.size)}</b></p>
  `;
  app.appendChild(progress);

  if (!state.analyze.done) {
    const spinner = document.createElement('div');
    spinner.textContent = 'Analyzing...';
    spinner.style.fontWeight = 'bold';
    spinner.style.color = '#888';
    spinner.style.margin = '20px 0';
    app.appendChild(spinner);
  } else {
    const continueBtn = document.createElement('button');
    continueBtn.className = 'button';
    continueBtn.textContent = 'Continue';
    continueBtn.onclick = () => {
      state.screen = 'copy';
      render();
    };
    app.appendChild(continueBtn);
  }
}

function startAnalyzing(volume) {
  // Recursively scan files, update state.analyze as we go
  let pending = 0;
  let done = false;
  function scanDir(dir) {
    try {
      const files = fs.readdirSync(dir);
      files.forEach(file => {
        const fullPath = path.join(dir, file);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            pending++;
            setTimeout(() => {
              scanDir(fullPath);
              pending--;
              if (pending === 0 && !done) finish();
            }, 0);
          } else if (stat.isFile()) {
            state.analyze.total++;
            state.analyze.size += stat.size;
            state.analyze.files.push(fullPath);
            const ext = path.extname(file).toLowerCase();
            if (AUDIO_EXT.includes(ext)) state.analyze.audio++;
            else if (VIDEO_EXT.includes(ext)) state.analyze.video++;
            else if (IMAGE_EXT.includes(ext)) state.analyze.image++;
            else if (DOC_EXT.includes(ext)) state.analyze.doc++;
            else state.analyze.other++;
            render();
          }
        } catch (e) {}
      });
    } catch (e) {}
  }
  function finish() {
    done = true;
    state.analyze.done = true;
    state.analyze.running = false;
    state.analyze.filesToCopy = state.analyze.files.slice();
    render();
  }
  pending = 1;
  scanDir(volume);
  pending--;
  if (pending === 0 && !done) finish();
}

function renderCopyScreen(app) {
  const title = document.createElement('h2');
  title.textContent = `Copy FROM: ${state.source}`;
  app.appendChild(title);

  const subtitle = document.createElement('div');
  subtitle.textContent = 'Select Destination Volume:';
  app.appendChild(subtitle);

  const list = document.createElement('div');
  list.className = 'list';
  const neededSpace = state.analyze.size;
  getVolumes().filter(v => v !== state.source).forEach(volume => {
    const free = getFreeSpace(volume);
    const hasSpace = free >= neededSpace;
    const item = document.createElement('div');
    item.className = 'list-item';
    item.textContent = `${volume} (Free: ${formatBytes(free)})`;
    if (!hasSpace) {
      item.style.color = '#aaa';
      item.style.background = '#f8f8f8';
      item.style.cursor = 'not-allowed';
    } else {
      item.onclick = () => {
        state.destination = volume;
        pickFolder(volume, folder => {
          state.destFolder = folder;
          state.filesToCopy = state.analyze.filesToCopy;
          state.screen = 'confirm';
          render();
        });
      };
    }
    list.appendChild(item);
  });
  app.appendChild(list);
}

function pickFolder(volume, cb) {
  // Use NW.js file dialog to pick a folder
  const input = document.createElement('input');
  input.type = 'file';
  input.nwdirectory = true;
  input.style.display = 'none';
  document.body.appendChild(input);
  input.onchange = () => {
    cb(input.value || volume);
    document.body.removeChild(input);
  };
  input.click();
}

function renderConfirmScreen(app) {
  const title = document.createElement('h2');
  title.textContent = 'Confirm Copy';
  app.appendChild(title);

  const summary = document.createElement('div');
  summary.innerHTML = `
    <p>You want to copy <b>${state.filesToCopy.length}</b> items from <b>${state.source}</b> to <b>${state.destFolder}</b>.</p>
    <p>Total size: <b>${formatBytes(state.analyze.size)}</b></p>
    <ul>
      <li>Audio: <b>${state.analyze.audio}</b></li>
      <li>Video: <b>${state.analyze.video}</b></li>
      <li>Images: <b>${state.analyze.image}</b></li>
      <li>Documents: <b>${state.analyze.doc}</b></li>
      <li>Other: <b>${state.analyze.other}</b></li>
    </ul>
  `;
  app.appendChild(summary);

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'button';
  confirmBtn.textContent = 'Confirm';
  confirmBtn.onclick = () => {
    state.screen = 'progress';
    render();
    startCopy();
  };
  app.appendChild(confirmBtn);
}

function renderProgressScreen(app) {
  const title = document.createElement('h2');
  title.textContent = 'Copy Progress';
  app.appendChild(title);

  const progressBar = document.createElement('div');
  progressBar.className = 'progress-bar';
  const progressInner = document.createElement('div');
  progressInner.className = 'progress-bar-inner';
  progressInner.style.width = `${state.copyProgress * 100}%`;
  progressBar.appendChild(progressInner);
  app.appendChild(progressBar);

  if (state.copyProgress >= 1) {
    const completeBtn = document.createElement('button');
    completeBtn.className = 'button';
    completeBtn.textContent = 'Complete';
    completeBtn.onclick = () => {
      nw.App.quit();
    };
    app.appendChild(completeBtn);
  }
}

function startCopy() {
  let copied = 0;
  const total = state.filesToCopy.length;
  function copyNext() {
    if (copied >= total) {
      state.copyProgress = 1;
      render();
      return;
    }
    const src = state.filesToCopy[copied];
    const dest = path.join(state.destFolder, path.basename(src));
    fs.copyFile(src, dest, err => {
      copied++;
      state.copyProgress = copied / total;
      render();
      setTimeout(copyNext, 10); // Simulate async/progress
    });
  }
  copyNext();
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

window.onload = render; 