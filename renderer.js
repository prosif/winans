// renderer.js
// Ported from app.js for Electron
const fs = require('fs');
const os = require('os');
const path = require('path');
const tf = require('@tensorflow/tfjs-node');
const nsfw = require('nsfwjs');
const { extractThumbnails } = require('./video_utils');
const pLimit = require('p-limit');

const AUDIO_EXT = ['.mp3', '.wav', '.aac', '.flac', '.ogg', '.m4a'];
const VIDEO_EXT = ['.mp4', '.avi', '.mov', '.mkv', '.wmv', '.flv', '.webm'];
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.webp'];
const DOC_EXT = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md', '.rtf', '.odt'];

const NSFW_CONCURRENCY = 2;
const nsfwLimit = pLimit(NSFW_CONCURRENCY);

// Store scroll positions for each list
let listScrollTops = {};

function saveListScrollTops() {
  Object.keys(expandedTypes).forEach(type => {
    if (expandedTypes[type]) {
      const ul = document.getElementById('filelist-' + type);
      if (ul) listScrollTops[type] = ul.scrollTop;
    }
  });
}

function restoreListScrollTops() {
  Object.keys(expandedTypes).forEach(type => {
    if (expandedTypes[type]) {
      const ul = document.getElementById('filelist-' + type);
      if (ul && listScrollTops[type] !== undefined) ul.scrollTop = listScrollTops[type];
    }
  });
}

function logToScreen(msg) {
  const logDiv = document.getElementById('log');
  if (logDiv) {
    logDiv.textContent += msg + '\n';
    logDiv.scrollTop = logDiv.scrollHeight;
  }
}
console.log = (...args) => { logToScreen(args.join(' ')); };
console.error = (...args) => { logToScreen('ERROR: ' + args.join(' ')); };

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
    for (let i = 67; i <= 90; i++) {
      const drive = String.fromCharCode(i) + ':\\';
      if (fs.existsSync(drive)) drives.push(drive);
    }
    return drives;
  }
  return ['/'];
}

function getFreeSpace(volume) {
  try {
    if (os.platform() === 'win32') {
      return 1 * 1024 * 1024 * 1024 * 1024;
    } else {
      const stat = fs.statSync(volume);
      if (stat && stat.dev) {
        const df = require('child_process').execSync(`df -k '${volume.replace(/'/g, "'\\''")}'`).toString();
        const lines = df.split('\n');
        if (lines.length > 1) {
          const parts = lines[1].split(/\s+/);
          if (parts.length > 3) {
            return parseInt(parts[3], 10) * 1024;
          }
        }
      }
    }
  } catch (e) { console.error('getFreeSpace error:', e); }
  return 0;
}

let state = {
  screen: 'main',
  source: null,
  destination: null,
  destFolder: null,
  filesToCopy: [],
  copyProgress: 0,
  debug: false,
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
    files: [],
    nsfwImages: 0,
    nsfwVideos: 0,
    nsfwImageFiles: [],
    nsfwVideoFiles: []
  }
};

// Konami code sequence
const KONAMI_CODE = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
let konamiIndex = 0;

// Add Konami code listener
document.addEventListener('keydown', (e) => {
  if (e.key === KONAMI_CODE[konamiIndex]) {
    konamiIndex++;
    if (konamiIndex === KONAMI_CODE.length) {
      state.debug = !state.debug;
      konamiIndex = 0;
      render();
    }
  } else {
    konamiIndex = 0;
  }
});

let nsfwModel = null;
async function loadNSFWModel() {
  if (!nsfwModel) {
    nsfwModel = await nsfw.load('file://./models/mobilenet_v2/model.json');
  }
  return nsfwModel;
}

// Add expanded state for collapsible lists
let expandedTypes = {
  audio: false,
  video: false,
  image: false,
  doc: false,
  other: false,
  nsfwImages: false,
  nsfwVideos: false
};

function toggleType(type) {
  expandedTypes[type] = !expandedTypes[type];
  render();
}

function getFilesByType(type) {
  return state.analyze.files.filter(file => {
    const ext = path.extname(file).toLowerCase();
    if (type === 'audio') return AUDIO_EXT.includes(ext);
    if (type === 'video') return VIDEO_EXT.includes(ext);
    if (type === 'image') return IMAGE_EXT.includes(ext);
    if (type === 'doc') return DOC_EXT.includes(ext);
    if (type === 'other') return (
      !AUDIO_EXT.includes(ext) &&
      !VIDEO_EXT.includes(ext) &&
      !IMAGE_EXT.includes(ext) &&
      !DOC_EXT.includes(ext)
    );
    return false;
  });
}

function render() {
  saveListScrollTops();
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
  restoreListScrollTops();
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
        files: [],
        nsfwImages: 0,
        nsfwVideos: 0,
        nsfwImageFiles: [],
        nsfwVideoFiles: []
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

  if (!state.debug) {
    // Simple progress view for non-debug mode
    const progressContainer = document.createElement('div');
    progressContainer.style.width = '100%';
    progressContainer.style.maxWidth = '400px';
    progressContainer.style.margin = '20px auto';
    
    const progressBar = document.createElement('div');
    progressBar.style.width = '100%';
    progressBar.style.height = '20px';
    progressBar.style.background = '#f0f0f0';
    progressBar.style.borderRadius = '10px';
    progressBar.style.overflow = 'hidden';
    
    const progressInner = document.createElement('div');
    const progress = state.analyze.total > 0 ? (state.analyze.files.length / state.analyze.total) : 0;
    progressInner.style.width = `${progress * 100}%`;
    progressInner.style.height = '100%';
    progressInner.style.background = '#4CAF50';
    progressInner.style.transition = 'width 0.3s ease';
    
    progressBar.appendChild(progressInner);
    progressContainer.appendChild(progressBar);
    
    const statusText = document.createElement('div');
    statusText.style.textAlign = 'center';
    statusText.style.marginTop = '10px';
    statusText.style.color = '#666';
    statusText.textContent = state.analyze.done ? 'Analysis complete' : `Finding files... (${state.analyze.files.length}/${state.analyze.total})`;
    
    progressContainer.appendChild(statusText);
    app.appendChild(progressContainer);
  } else {
    // Detailed debug view
    function makeSection(label, type, count, files) {
      const section = document.createElement('div');
      section.style.marginBottom = '8px';
      const header = document.createElement('div');
      header.style.cursor = 'pointer';
      header.style.fontWeight = 'bold';
      header.onclick = () => toggleType(type);
      header.textContent = `${label}: ${count} ${expandedTypes[type] ? '▼' : '▶'}`;
      section.appendChild(header);
      if (expandedTypes[type]) {
        const list = document.createElement('ul');
        list.id = 'filelist-' + type;
        list.style.margin = '4px 0 4px 20px';
        list.style.maxHeight = '200px';
        list.style.overflowY = 'auto';
        files.forEach(f => {
          const li = document.createElement('li');
          li.style.cursor = 'pointer';
          li.style.color = '#0066cc';
          li.textContent = f;
          li.onclick = () => {
            // Use Electron to open the file
            require('electron').shell.openPath(f);
          };
          li.onmouseover = () => {
            li.style.textDecoration = 'underline';
          };
          li.onmouseout = () => {
            li.style.textDecoration = 'none';
          };
          list.appendChild(li);
        });
        section.appendChild(list);
      }
      return section;
    }

    app.appendChild(makeSection('Audio', 'audio', state.analyze.audio, getFilesByType('audio')));
    app.appendChild(makeSection('Video', 'video', state.analyze.video, getFilesByType('video')));
    app.appendChild(makeSection('Images', 'image', state.analyze.image, getFilesByType('image')));
    app.appendChild(makeSection('Documents', 'doc', state.analyze.doc, getFilesByType('doc')));
    app.appendChild(makeSection('Other', 'other', state.analyze.other, getFilesByType('other')));
    app.appendChild(makeSection('NSFW Images', 'nsfwImages', state.analyze.nsfwImages, state.analyze.nsfwImageFiles));
    app.appendChild(makeSection('NSFW Videos', 'nsfwVideos', state.analyze.nsfwVideos, state.analyze.nsfwVideoFiles));

    const nsfwDiv = document.createElement('div');
    nsfwDiv.innerHTML = `
      <p>Total files: <b>${state.analyze.total}</b></p>
      <p>Total size: <b>${formatBytes(state.analyze.size)}</b></p>
    `;
    app.appendChild(nsfwDiv);
  }

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
  (async () => {
    const model = await loadNSFWModel();
    let nsfwPromises = [];
    state.analyze.nsfwImages = 0;
    state.analyze.nsfwVideos = 0;
    state.analyze.nsfwImageFiles = [];
    state.analyze.nsfwVideoFiles = [];

    // First pass: count total files
    let totalFiles = 0;
    function countFiles(dir) {
      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (file.startsWith('.')) continue; // Ignore hidden files and directories
          const fullPath = path.join(dir, file);
          try {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
              countFiles(fullPath);
            } else if (stat.isFile()) {
              totalFiles++;
            }
          } catch (e) { console.error('Stat error:', e); }
        }
      } catch (e) { console.error('Read dir error:', e); }
    }
    countFiles(volume);
    state.analyze.total = totalFiles;

    let processedFiles = 0;
    async function scanDir(dir) {
      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (file.startsWith('.')) continue; // Ignore hidden files and directories
          const fullPath = path.join(dir, file);
          try {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
              await scanDir(fullPath);
            } else if (stat.isFile()) {
              processedFiles++;
              state.analyze.size += stat.size;
              state.analyze.files.push(fullPath);
              const ext = path.extname(file).toLowerCase();
              if (AUDIO_EXT.includes(ext)) state.analyze.audio++;
              else if (VIDEO_EXT.includes(ext)) {
                state.analyze.video++;
                nsfwPromises.push(nsfwLimit(async () => {
                  try {
                    const thumbs = await extractThumbnails(fullPath, 3, '.electron-thumbs');
                    let nsfwFound = false;
                    for (const thumb of thumbs) {
                      try {
                        if (!fs.existsSync(thumb)) {
                          console.warn('Thumbnail missing, skipping:', thumb);
                          continue;
                        }
                        const image = await tf.node.decodeImage(require('fs').readFileSync(thumb), 3);
                        const predictions = await model.classify(image);
                        image.dispose();
                        if (predictions.some(p => (['Hentai', 'Porn', 'Sexy'].includes(p.className) && p.probability > 0.7))) {
                          nsfwFound = true;
                        }
                      } catch (e) { console.error('NSFW video image error:', e); }
                      try { require('fs').unlinkSync(thumb); } catch (e) {}
                    }
                    if (nsfwFound) {
                      state.analyze.nsfwVideos++;
                      state.analyze.nsfwVideoFiles.push(fullPath);
                    }
                  } catch (e) { console.error('NSFW video error:', e); }
                  render();
                }));
              }
              else if (IMAGE_EXT.includes(ext)) {
                state.analyze.image++;
                nsfwPromises.push(nsfwLimit(async () => {
                  try {
                    const image = await tf.node.decodeImage(require('fs').readFileSync(fullPath), 3);
                    const predictions = await model.classify(image);
                    image.dispose();
                    if (predictions.some(p => (['Hentai', 'Porn', 'Sexy'].includes(p.className) && p.probability > 0.7))) {
                      state.analyze.nsfwImages++;
                      state.analyze.nsfwImageFiles.push(fullPath);
                    }
                  } catch (e) { console.error('NSFW image error:', e); }
                  render();
                }));
              }
              else if (DOC_EXT.includes(ext)) state.analyze.doc++;
              else state.analyze.other++;
              render();
            }
          } catch (e) { console.error('Stat error:', e); }
        }
      } catch (e) { console.error('Read dir error:', e); }
    }
    await scanDir(volume);
    await Promise.all(nsfwPromises);
    state.analyze.done = true;
    state.analyze.running = false;
    state.analyze.filesToCopy = state.analyze.files.slice();
    render();
  })();
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
  // Use Electron file dialog
  const input = document.createElement('input');
  input.type = 'file';
  input.webkitdirectory = true;
  input.style.display = 'none';
  document.body.appendChild(input);
  input.onchange = () => {
    cb(input.files && input.files.length > 0 ? input.files[0].path : volume);
    document.body.removeChild(input);
  };
  input.click();
}

function renderConfirmScreen(app) {
  const title = document.createElement('h2');
  title.textContent = 'Confirm Copy';
  app.appendChild(title);

  function makeSection(label, type, count, files) {
    const section = document.createElement('div');
    section.style.marginBottom = '8px';
    const header = document.createElement('div');
    header.style.cursor = 'pointer';
    header.style.fontWeight = 'bold';
    header.onclick = () => toggleType(type);
    header.textContent = `${label}: ${count} ${expandedTypes[type] ? '▼' : '▶'}`;
    section.appendChild(header);
    if (expandedTypes[type]) {
      const list = document.createElement('ul');
      list.id = 'filelist-' + type;
      list.style.margin = '4px 0 4px 20px';
      list.style.maxHeight = '200px';
      list.style.overflowY = 'auto';
      files.forEach(f => {
        const li = document.createElement('li');
        li.textContent = f;
        list.appendChild(li);
      });
      section.appendChild(list);
    }
    return section;
  }

  const summary = document.createElement('div');
  summary.innerHTML = `
    <p>You want to copy <b>${state.filesToCopy.length}</b> items from <b>${state.source}</b> to <b>${state.destFolder}</b>.</p>
    <p>Total size: <b>${formatBytes(state.analyze.size)}</b></p>
  `;
  app.appendChild(summary);

  app.appendChild(makeSection('Audio', 'audio', state.analyze.audio, getFilesByType('audio')));
  app.appendChild(makeSection('Video', 'video', state.analyze.video, getFilesByType('video')));
  app.appendChild(makeSection('Images', 'image', state.analyze.image, getFilesByType('image')));
  app.appendChild(makeSection('Documents', 'doc', state.analyze.doc, getFilesByType('doc')));
  app.appendChild(makeSection('Other', 'other', state.analyze.other, getFilesByType('other')));
  // NSFW Images
  app.appendChild(makeSection('NSFW Images', 'nsfwImages', state.analyze.nsfwImages, state.analyze.nsfwImageFiles));
  // NSFW Videos
  app.appendChild(makeSection('NSFW Videos', 'nsfwVideos', state.analyze.nsfwVideos, state.analyze.nsfwVideoFiles));

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
      window.close();
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
      setTimeout(copyNext, 10);
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